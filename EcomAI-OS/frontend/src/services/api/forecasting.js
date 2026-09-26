// Demand forecasting and the portfolio overview, backed by the tenant API.
//
// The forecast is the trained model wherever the eligibility gate allows it and
// a labeled baseline where it does not. `fallbackUsed` is carried through to the
// page so a baseline projection is never presented as a model projection.

import * as http from './http';
import { toForecast, toPortfolioForecast } from './adapters';
import { timeAgo } from '../../lib/utils';

export async function getProductForecast(user, productId, horizon = 30) {
  const raw = await http.fetchProductForecast(user, productId, horizon);
  return toForecast(raw);
}

export async function getForecastOverview(user, { horizon = 30, category = null, productId = null } = {}) {
  if (productId) {
    const forecast = await getProductForecast(user, productId, horizon);
    return buildOverview(
      {
        horizon,
        scope: 'product',
        points: forecast.points,
        actuals: forecast.actuals,
        total: forecast.total,
        avgDaily: forecast.avgDaily,
        trend: forecast.trend,
        growthPct: forecast.growthPct,
      },
      horizon,
      { rows: [], inc: null, dec: null, product: toProductRow(forecast) },
    );
  }

  const raw = await http.fetchPortfolioForecast(user, { horizon, category });
  const portfolio = toPortfolioForecast(raw);
  return buildOverview(portfolio, horizon, {
    rows: portfolio.rows,
    inc: portfolio.increasing,
    dec: portfolio.decreasing,
  });
}

function toProductRow(forecast) {
  return {
    id: forecast.productId,
    name: forecast.productName,
    category: forecast.category,
    trend: forecast.trend,
    growthPct: forecast.growthPct,
    fallbackUsed: forecast.fallbackUsed,
  };
}

function buildOverview(source, horizon, extra) {
  const generatedAt = new Date().toISOString();
  return {
    horizon,
    scope: extra.rows && extra.rows.length ? 'portfolio' : extra.product ? 'product' : 'portfolio',
    metrics: {
      avgExpectedDemand: source.avgDaily,
      expectedGrowth: source.growthPct ?? 0,
      growing: extra.inc ?? null,
      decreasing: extra.dec ?? null,
      totalForecastUnits: source.total,
    },
    chart: {
      actuals: source.actuals || [],
      forecast: source.points || [],
    },
    rows: extra.rows || [],
    product: extra.product || null,
    howCalculated: [
      'EcomAI-OS reads your own daily sales history to establish baseline demand, weekly patterns, and any growth or decline trend.',
      'The demand forecast projects the next ' + horizon + ' days from that history, weighted toward your most recent weeks of activity.',
      'The trained model is used wherever your data clears the eligibility gate; where it does not, a labeled baseline estimate is shown and labelled as such.',
      'Forecasts improve as more sales data is captured, so keeping your sales history up to date makes predictions more accurate.',
    ],
    generatedAt,
    generatedAtLabel: timeAgo(generatedAt),
  };
}

/**
 * Confirm a portfolio forecast can be produced.
 *
 * This is a read, not a decision: it writes no audit row and stores no "has run"
 * flag, so the onboarding checklist can only be marked complete when the engine
 * genuinely returned points.
 */
export async function generatePortfolioForecast(user) {
  const raw = await http.fetchPortfolioForecast(user, { horizon: 1 });
  const portfolio = toPortfolioForecast(raw);
  if (portfolio.productsInScope === 0) {
    throw new Error('Add at least one product before generating a forecast.');
  }
  if (portfolio.productsForecasted === 0) {
    throw new Error(
      'Forecast cannot be generated because there is not enough historical sales data.',
    );
  }
  return { ok: true, products: portfolio.productsForecasted };
}
