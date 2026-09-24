// Inventory service — portfolio KPIs, health distribution and product tables.

import { getDB, latency, randomError } from './mock/db';
import { get30DayForecast, getTrendAndGrowth } from './forecastService';
import { classifyStatus } from './mock/catalog';

const URGENCY = { critical: 0, low: 1, overstocked: 2, healthy: 3 };

export async function getInventoryOverview(user) {
  await latency(450);
  const db = getDB(user);
  const { products } = db;

  const totalProducts = products.length;
  const critical = products.filter((p) => p.status === 'critical');
  const low = products.filter((p) => p.status === 'low');
  const overstocked = products.filter((p) => p.status === 'overstocked');
  const healthy = products.filter((p) => p.status === 'healthy');
  const stockoutRisk = products.filter((p) => p.stockoutRisk);

  const totalValue = products.reduce((s, p) => s + p.currentStock * p.unitCost, 0);
  const totalUnits = products.reduce((s, p) => s + p.currentStock, 0);

  const categoryBreakdown = {};
  for (const p of products) {
    if (!categoryBreakdown[p.category]) {
      categoryBreakdown[p.category] = { products: 0, units: 0, value: 0, critical: 0 };
    }
    const c = categoryBreakdown[p.category];
    c.products++;
    c.units += p.currentStock;
    c.value += p.currentStock * p.unitCost;
    if (p.status === 'critical') c.critical++;
  }

  return {
    kpis: {
      totalProducts,
      productsToReorder: low.length, // below reorder point, not yet critical
      stockoutRisk: stockoutRisk.length,
      excessInventory: overstocked.length,
      inventoryValue: totalValue,
      inventoryValueLabel: '₹' + formatLakh(totalValue),
      totalUnits,
    },
    health: {
      healthy: healthy.length + overstocked.length,
      atRisk: low.length,
      critical: critical.length,
      total: totalProducts,
    },
    critical,
    low,
    overstocked,
    categories: Object.entries(categoryBreakdown).map(([name, stat]) => ({ name, ...stat })),
  };
}

function formatLakh(value) {
  if (value >= 10000000) return (value / 10000000).toFixed(2) + 'Cr';
  return (value / 100000).toFixed(1) + 'L';
}

export async function listProducts(user, filters = {}) {
  await latency(400);
  const db = getDB(user);
  const {
    search = '',
    category = 'all',
    status = 'all',
    sort = 'urgency',
    page = 1,
    pageSize = 12,
  } = filters;

  let items = db.products.map((p) => ({
    ...p,
    forecast30: safeForecast30(db, p),
  }));

  if (search) {
    const q = String(search).toLowerCase();
    items = items.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q),
    );
  }
  if (category && category !== 'all') items = items.filter((p) => p.category === category);
  if (status && status !== 'all') items = items.filter((p) => p.status === status);

  const valueOf = (p) => p.currentStock * p.unitCost;
  switch (sort) {
    case 'name':
      items.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'stock':
      items.sort((a, b) => a.currentStock - b.currentStock);
      break;
    case 'value':
      items.sort((a, b) => valueOf(b) - valueOf(a));
      break;
    case 'urgency':
    default:
      items.sort((a, b) => {
        const d = URGENCY[a.status] - URGENCY[b.status];
        if (d !== 0) return d;
        return b.currentStock - a.currentStock;
      });
  }

  const total = items.length;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total, page, pageSize };
}

function safeForecast30(db, p) {
  try {
    return get30DayForecast(db, p.id).total;
  } catch {
    return null;
  }
}

export async function getProduct(user, productId) {
  await latency(400);
  const db = getDB(user);
  const p = db.products.find((x) => x.id === productId);
  if (!p) throw randomError('This product could not be found.');
  let forecast = null;
  try {
    forecast = get30DayForecast(db, productId);
  } catch {
    /* not enough history */
  }
  const trend = forecast
    ? { trend: forecast.trend, growthPct: forecast.growthPct }
    : { trend: 'stable', growthPct: 0 };
  const leadTimeDemandRaw = p.dailyAvg * p.leadTimeDays;
  return {
    ...p,
    trend,
    forecast30: forecast?.total ?? null,
    forecast30AvgDaily: forecast?.avgDaily ?? null,
    recommendedOrderQty: db.recommendedOrderQty(p),
    leadTimeDemand: Math.round(leadTimeDemandRaw),
    projectedDemandDuringLeadTime: Math.round(
      (forecast?.points?.slice(0, p.leadTimeDays).reduce((s, pt) => s + pt.forecast, 0) ?? leadTimeDemandRaw),
    ),
  };
}

export async function updateStock(user, productId, newStock) {
  await latency(450);
  const db = getDB(user);
  const p = db.products.find((x) => x.id === productId);
  if (!p) throw randomError('This product could not be found.');
  db.updateProduct(productId, { currentStock: Math.max(0, Number(newStock)) });
  return db.products.find((x) => x.id === productId);
}

export async function getInventoryTimeline(user, productId, { withReorder = true, days = 45 } = {}) {
  await latency(500);
  const db = getDB(user);
  const p = db.products.find((x) => x.id === productId);
  if (!p) throw randomError('This product could not be found.');

  const series = db.getSales(productId);
  const fc = (() => {
    try {
      return get30DayForecast(db, productId);
    } catch {
      return null;
    }
  })();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const past7 = series.slice(-7).map((s) => s.units);
  const demandForDay = (offset) => {
    if (offset < 0) {
      const s = series[series.length + offset];
      return s ? s.units : 0;
    }
    if (fc && offset >= 0 && offset < fc.points.length) return fc.points[offset].forecast;
    return p.dailyAvg;
  };

  let stock = p.currentStock;
  const points = [];
  const cumulative = { withReorder: {}, withoutReorder: {} };
  let reorderPlaced = false;

  for (let offset = -7; offset < days; offset++) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    const demand = demandForDay(offset);
    if (withReorder && !reorderPlaced && p.status !== 'healthy' && p.status !== 'overstocked') {
      reorderPlaced = true;
    }
    stock = Math.max(0, stock - demand);
    points.push({ date: d.toISOString().slice(0, 10), stock: Math.round(stock), demand: Math.round(demand) });
  }

  let stockWithout = p.currentStock;
  for (let offset = -7; offset < days; offset++) {
    stockWithout = Math.max(0, stockWithout - demandForDay(offset));
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    cumulative.withoutReorder[d.toISOString().slice(0, 10)] = Math.round(stockWithout);
  }

  return {
    productId,
    points,
    currentStock: p.currentStock,
    reorderPoint: p.reorderPoint,
    expectedDepletion: (() => {
      let running = p.currentStock;
      for (let offset = 0; offset < 60; offset++) {
        running -= demandForDay(offset);
        if (running <= 0) {
          const d = new Date(today);
          d.setDate(today.getDate() + offset);
          return d.toISOString().slice(0, 10);
        }
      }
      return null;
    })(),
    pastAverage: past7.length ? Math.round(past7.reduce((s, v) => s + v, 0) / past7.length) : 0,
  };
}

export { classifyStatus };