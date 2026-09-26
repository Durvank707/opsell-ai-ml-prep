// Inventory intelligence — turns stock + demand signals into plain business actions.
//
// In `mock` mode the actions are derived in the browser from the deterministic
// store. In `api` mode they come from the server's recommendation endpoint, so
// the wording and the quantities are the ones the inventory engine produced
// rather than a second, browser-side restatement of them.

import { getDB, latency } from './mock/db';
import { get30DayForecast } from './forecastService';
import { usingApi } from './api/mode';
import * as api from './api/intelligence';

export const REC_TYPES = ['critical', 'reorder', 'monitor', 'no_action'];

function buildRecommendation(db, p) {
  let forecast;
  try {
    forecast = get30DayForecast(db, p.id);
  } catch {
    forecast = null;
  }
  const growthPct = forecast?.growthPct ?? 0;
  const demand = forecast?.avgDaily ?? p.dailyAvg;
  const projectedLeadTimeDemand = Math.round(
    forecast?.points?.slice(0, p.leadTimeDays).reduce((s, pt) => s + pt.forecast, 0) ??
      p.dailyAvg * p.leadTimeDays,
  );
  const position = p.currentStock + (p.openOrderQty || 0);
  const recommendedOrder = db.recommendedOrderQty(p);

  let type;
  let title;
  let reason;
  let actionLabel;

  if (p.status === 'critical' || (p.status === 'low' && p.stockoutRisk)) {
    type = 'critical';
    title = 'Reorder Required';
    reason =
      projectedLeadTimeDemand > position
        ? `Projected demand of ${projectedLeadTimeDemand} units during the ${p.leadTimeDays}-day lead time exceeds available inventory of ${position} units.`
        : `Current inventory of ${position} units is below the safety stock level of ${p.safetyStock} units.`;
    actionLabel = 'Reorder now';
  } else if (p.status === 'low') {
    type = 'reorder';
    title = 'Reorder Recommended';
    reason = `Inventory of ${position} units is below the reorder point of ${p.reorderPoint} units, with a ${p.leadTimeDays}-day supplier lead time.`;
    actionLabel = 'Review reorder';
  } else if (p.status === 'healthy' && growthPct > 2) {
    type = 'monitor';
    title = 'Monitor';
    reason = 'Inventory is currently sufficient, but demand is increasing. Keep an eye on stock levels.';
    actionLabel = 'View product';
  } else if (p.status === 'overstocked') {
    type = 'reorder';
    title = 'Excess Inventory';
    reason = 'Stock is well above expected demand. Consider a promotion or slower replenishment.';
    actionLabel = 'Review stock';
  } else {
    type = 'no_action';
    title = 'No Action';
    reason = 'Inventory levels are healthy.';
    actionLabel = 'View product';
  }

  return {
    id: p.id,
    productId: p.id,
    name: p.name,
    category: p.category,
    type,
    title,
    currentStock: p.currentStock,
    reorderPoint: p.reorderPoint,
    safetyStock: p.safetyStock,
    leadTimeDays: p.leadTimeDays,
    projectedDemand: projectedLeadTimeDemand,
    dailyDemand: Math.round(demand * 10) / 10,
    recommendedOrder,
    reason,
    actionLabel,
    growthPct,
    inventoryPosition: position,
    lastUpdated: p.updatedAt,
  };
}

export async function getRecommendations(user, { filter = 'all' } = {}) {
  if (usingApi()) return api.getRecommendations(user, { filter });
  await latency(550);
  const db = getDB(user);
  const all = db.products.map((p) => buildRecommendation(db, p));

  const counts = {
    all: all.length,
    critical: all.filter((r) => r.type === 'critical').length,
    reorder: all.filter((r) => r.type === 'reorder').length,
    monitor: all.filter((r) => r.type === 'monitor').length,
    no_action: all.filter((r) => r.type === 'no_action').length,
  };

  const filtered = filter === 'all' ? all : all.filter((r) => r.type === filter);
  const priority = { critical: 0, reorder: 1, monitor: 2, no_action: 3 };
  filtered.sort((a, b) => priority[a.type] - priority[b.type] || a.currentStock - b.currentStock);

  // Return the most actionable subset — the remaining can be paged later.
  return { items: filtered, counts, total: filtered.length, filter };
}