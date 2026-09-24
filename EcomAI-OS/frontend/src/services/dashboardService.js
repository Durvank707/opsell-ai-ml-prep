// Dashboard service — KPIs, health donut, demand chart, alerts, activity.

import { getDB, latency } from './mock/db';
import { getInventoryOverview } from './inventoryService';
import { portfolioDailyActual, portfolioForecast } from './forecastService';
import { formatINR, formatDate } from '../lib/utils';

export async function getDashboard(user, { period = 7 } = {}) {
  await latency(500);
  const db = getDB(user);
  const ov = await getInventoryOverview(user);

  // Demand chart: last `period` days of portfolio actuals + forecast
  const actuals = portfolioDailyActual(db, Math.max(period, 14)).slice(-period);
  const forecast = portfolioForecast(db, period);

  // Merge into one series: past actuals (relative to today), then forecast tomorrow+
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const chartPeriods = [7, 30, 90];
  const chart = (periodDays) => {
    const actual = portfolioDailyActual(db, periodDays).slice(-periodDays);
    const fc = portfolioForecast(db, periodDays);
    return {
      actual: actual.map((a) => ({ date: a.date, units: a.units })),
      forecast: fc,
    };
  };

  const alerts = db.products
    .filter((p) => p.status === 'critical' || p.status === 'low')
    .sort((a, b) => URGENCY[a.status] - URGENCY[b.status] || a.currentStock - b.currentStock)
    .slice(0, 6)
    .map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      currentStock: p.currentStock,
      reorderPoint: p.reorderPoint,
      recommendedAction:
        p.status === 'healthy' || p.status === 'overstocked'
          ? 'No action'
          : `Reorder ${db.recommendedOrderQty(p) || 20} units`,
      severity: p.status === 'critical' ? 'critical' : 'warning',
    }));

  const activity = (db.activity || []).map((a) => ({
    ...a,
    label: formatDate(a.time, { month: 'short' }),
  }));

  return {
    user: db.user,
    setup: db.setupProgress(),
    kpis: ov.kpis,
    health: ov.health,
    chart: chart(period),
    period,
    chartPeriods,
    alerts,
    activity,
    alertCount: alerts.length,
    totalAlertProductCount: db.products.filter((p) => p.status === 'critical' || p.status === 'low').length,
    currency: db.settings.currency,
    valueLabel: formatINR(ov.kpis.inventoryValue, { lakh: true }),
  };
}

const URGENCY = { critical: 0, low: 1, overstocked: 2, healthy: 3 };

export async function getWorkspace(user) {
  await latency(250);
  const db = getDB(user);
  const setup = db.setupProgress();
  return {
    user: db.user,
    setup,
    counts: {
      products: db.products.length,
      salesRecords: db.salesMeta.totalRecords,
      unread: db.unreadCount(),
    },
  };
}