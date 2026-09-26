// Demand forecasting service.
//
// Two implementations sit behind the async API below. The default `mock` mode
// projects demand in the browser from the deterministic store; with
// `VITE_DATA_MODE=api` the same calls are served by the tenant API, where the
// trained model is used wherever the eligibility gate passes and a labeled
// baseline is used where it does not. The synchronous helpers further down are
// mock-only by nature — they read the in-browser store directly and have no
// API counterpart, so they are not reachable in `api` mode.

import { getDB, latency, randomError } from './mock/db';
import { mulberry32, hashString, timeAgo } from '../lib/utils';
import { usingApi } from './api/mode';
import * as api from './api/forecasting';

const WEEKDAY_FACTOR = [0.8, 0.9, 0.95, 1.0, 1.08, 1.3, 1.18];
const Z = 1.28; // ~80% interval lower/upper multiplier

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function classifyTrend(recent7, prev21) {
  if (prev21 <= 0.001) return 'stable';
  const growth = recent7 / prev21 - 1;
  if (growth > 0.02) return 'increasing';
  if (growth < -0.02) return 'decreasing';
  return 'stable';
}

/**
 * Compute a full forecast for one product. Synchronous + cached.
 * Returns { productId, productName, category, horizon, points, actuals, ... }
 */
export function computeProductForecastSync(db, productId, horizon) {
  const cacheKey = `${productId}:${horizon}`;
  const cached = db.forecasts.get(cacheKey);
  if (cached) return cached;

  const p = db.products.find((x) => x.id === productId);
  if (!p) throw randomError('Product not found.');

  const series = db.getSales(productId);
  const history = series.filter((s) => s.units > 0).map((s) => s.units);
  if (history.length < 7) {
    throw randomError('Forecast cannot be generated because there is not enough historical sales data.');
  }

  const actualsSlice = series.slice(-60);
  const recent28 = series.slice(-28).map((s) => s.units);
  const prev28 = series.slice(-56, -28).map((s) => s.units);
  const base = mean(recent28);
  const prevBase = Math.max(mean(prev28), 0.001);
  const slope = (base - prevBase) / 28; // daily drift
  const sigma = p.sigma || base * 0.4;

  const recent7 = mean(series.slice(-7).map((s) => s.units));
  const prev21 = mean(series.slice(-28, -7).map((s) => s.units));
  const trend = classifyTrend(recent7, prev21);
  const growthPct = ((recent7 / Math.max(prev21, 0.001)) - 1) * 100;

  const rand = mulberry32(hashString(`${db.user.id}:${productId}:fc:${horizon}`)());
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const points = [];
  for (let i = 1; i <= horizon; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const seasonal = WEEKDAY_FACTOR[d.getDay()];
    const drift = 1 + slope * i;
    const noise = (rand() + rand() - 1) * 0.35;
    const forecast = Math.max(0, base * seasonal * drift * (1 + noise));
    points.push({
      date: d.toISOString().slice(0, 10),
      forecast: Math.round(forecast * 10) / 10,
      lower: Math.max(0, Math.round((forecast - Z * sigma) * 10) / 10),
      upper: Math.round((forecast + Z * sigma) * 10) / 10,
    });
  }

  const total = points.reduce((s, pt) => s + pt.forecast, 0);
  const peak = points.reduce((best, pt) => (pt.forecast > best.forecast ? pt : best), points[0]);
  const actuals = actualsSlice.map((s) => ({ date: s.date, units: s.units }));

  const result = {
    productId,
    productName: p.name,
    category: p.category,
    horizon,
    points,
    actuals,
    total: Math.round(total),
    avgDaily: Math.round((total / horizon) * 10) / 10,
    peakDate: peak.date,
    peakUnits: peak.forecast,
    trend,
    growthPct: Math.round(growthPct * 10) / 10,
    generatedAt: new Date().toISOString(),
  };
  db.forecasts.set(cacheKey, result);
  return result;
}

/** Where many products are involved, returning the latest result synchronously. */
export function computeForecast30Cache(db) {
  for (const p of db.products) {
    if (!db.forecasts.has(`${p.id}:30`)) {
      try {
        computeProductForecastSync(db, p.id, 30);
      } catch {
        /* skip products with too little history */
      }
    }
  }
}

export function get30DayForecast(db, productId) {
  return computeProductForecastSync(db, productId, 30);
}

export function getTrendAndGrowth(db, productId) {
  const fc = computeProductForecastSync(db, productId, 30);
  return { trend: fc.trend, growthPct: fc.growthPct };
}

/** Aggregate actual demand across the portfolio for the last `days` days. */
export function portfolioDailyActual(db, days) {
  const map = {};
  for (const p of db.products) {
    const series = db.getSales(p.id);
    const slice = series.slice(-Math.max(days, 14));
    for (const s of slice) map[s.date] = (map[s.date] || 0) + s.units;
  }
  return Object.entries(map)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, units]) => ({ date, units }));
}

/** Aggregate AI forecast across the whole portfolio. */
export function portfolioForecast(db, horizon) {
  const sums = Array.from({ length: horizon }, () => ({ forecast: 0, lower: 0, upper: 0 }));
  for (const p of db.products) {
    let fc;
    try {
      fc = computeProductForecastSync(db, p.id, horizon);
    } catch {
      continue;
    }
    fc.points.forEach((pt, i) => {
      sums[i].forecast += pt.forecast;
      sums[i].lower += pt.lower;
      sums[i].upper += pt.upper;
    });
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return sums.map((s, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i + 1);
    return {
      date: d.toISOString().slice(0, 10),
      forecast: Math.round(s.forecast),
      lower: Math.round(s.lower),
      upper: Math.round(s.upper),
    };
  });
}

// ------------------------------------------------------------------ async API

export async function getProductForecast(user, productId, horizon = 30) {
  if (usingApi()) return api.getProductForecast(user, productId, horizon);
  await latency(450);
  const db = getDB(user);
  return computeProductForecastSync(db, productId, horizon);
}

export async function getForecastOverview(user, { horizon = 30, category = null, productId = null } = {}) {
  if (usingApi()) return api.getForecastOverview(user, { horizon, category, productId });
  await latency(600);
  const db = getDB(user);
  if (productId) {
    const fc = computeProductForecastSync(db, productId, horizon);
    return buildOverview(user, db, fc, horizon);
  }

  const scope = category ? db.products.filter((p) => p.category === category) : db.products;
  const actual = portfolioDailyActual(db, horizon);
  const sums = Array.from({ length: horizon }, () => ({ forecast: 0, lower: 0, upper: 0 }));
  let inc = 0;
  let dec = 0;
  let stable = 0;
  let totalForecast = 0;
  const rows = [];
  for (const p of scope) {
    let fc;
    try {
      fc = computeProductForecastSync(db, p.id, horizon);
    } catch {
      continue;
    }
    fc.points.forEach((pt, i) => {
      sums[i].forecast += pt.forecast;
      sums[i].lower += pt.lower;
      sums[i].upper += pt.upper;
    });
    totalForecast += fc.total;
    if (fc.trend === 'increasing') inc++;
    else if (fc.trend === 'decreasing') dec++;
    else stable++;
    rows.push({
      id: p.id,
      name: p.name,
      category: p.category,
      current: p.dailyAvg,
      forecast: fc.avgDaily * horizon,
      forecastAvgDaily: fc.avgDaily,
      changePct: fc.growthPct,
      trend: fc.trend,
      totalForecast: fc.total,
    });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const chart = sums.map((s, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i + 1);
    return {
      date: d.toISOString().slice(0, 10),
      forecast: Math.round(s.forecast),
      lower: Math.round(s.lower),
      upper: Math.round(s.upper),
    };
  });

  const avgDaily = scope.length
    ? (Object.values(actual).reduce((s, a) => s + a.units, 0) / Math.max(1, actual.length))
    : 0;

  return buildOverview(user, db, {
    points: chart,
    actuals: actual,
    total: totalForecast,
    avgDaily: Math.round(avgDaily * 10) / 10,
    trend: inc > dec ? 'increasing' : dec > inc ? 'decreasing' : 'stable',
    growthPct: 0,
  }, horizon, { rows, inc, dec, stable });
}

function buildOverview(user, db, fc, horizon, extra = {}) {
  return {
    horizon,
    scope: extra.rows ? 'portfolio' : 'product',
    metrics: {
      avgExpectedDemand: fc.avgDaily,
      expectedGrowth: fc.growthPct,
      growing: extra.inc ?? null,
      decreasing: extra.dec ?? null,
      totalForecastUnits: fc.total,
    },
    chart: {
      actuals: fc.actuals || [],
      forecast: fc.points || [],
    },
    rows: extra.rows || [],
    product: extra.product || null,
    howCalculated: [
      'EcomAI-OS analyses your recent daily sales history to identify baseline demand, weekly purchase patterns, and any growth or decline trend.',
      'The AI demand forecast projects the next ' + horizon + ' days using your store\u2019s historical patterns, weighted toward the most recent 28 days of activity.',
      'Seasonal factors (weekday peaks and weekend dips) are applied, and a confidence band shows the most likely range for each day.',
      'Forecasts improve automatically as more sales data is captured, so keeping your sales history up to date makes predictions more accurate.',
    ],
    generatedAt: new Date().toISOString(),
    generatedAtLabel: timeAgo(new Date().toISOString()),
  };
}

/** Generate the portfolio forecast explicitly (onboarding step 3). */
export async function generatePortfolioForecast(user) {
  if (usingApi()) return api.generatePortfolioForecast(user);
  await latency(1500);
  const db = getDB(user);
  if (db.products.length === 0) {
    throw randomError('Add at least one product before generating a forecast.');
  }
  const rows = db.products.filter((p) => db.getSales(p.id).filter((s) => s.units > 0).length >= 7);
  if (rows.length === 0) {
    throw randomError('Forecast cannot be generated because there is not enough historical sales data.');
  }
  computeForecast30Cache(db);
  db.forecastGenerated = true;
  db.pushActivity('forecast_generated', `Portfolio demand forecast generated for ${rows.length} SKUs.`);
  db.pushNotification({
    title: 'Demand forecast generated successfully.',
    message: `Your AI demand forecast for ${rows.length} products is ready.`,
    severity: 'success',
  });
  return { ok: true, products: rows.length };
}

export { randomError };