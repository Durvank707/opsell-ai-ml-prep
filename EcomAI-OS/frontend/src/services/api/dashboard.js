// Dashboard and workspace shell, backed by the tenant API.
//
// These are the app's landing views, so they assemble several real reads in
// parallel rather than one fat endpoint: inventory health, the demand chart,
// the ranked actions, and the tenant's own audit trail. Nothing here is
// computed from a stored flag — every number traces to an engine call.

import * as http from './http';
import { toActivity, toSetupProgress } from './adapters';
import { getUnreadCount } from './preferences';
import { formatINR } from '../../lib/utils';
import { requireApiSession } from './mode';

const CHART_PERIODS = [7, 30, 90];
const URGENCY = { critical: 0, low: 1, overstocked: 2, healthy: 3 };

export async function getDashboard(user, { period = 7 } = {}) {
  requireApiSession();
  const days = Math.max(period, 1);

  const [overview, forecast, recommendations, audit, summary] = await Promise.all([
    http.fetchInventoryOverview(user),
    http.fetchPortfolioForecast(user, { horizon: days }),
    http.fetchRecommendations(user),
    http.fetchAudit(user),
    http.fetchSalesSummary(user),
  ]);

  const health = overview.health || {};
  const kpis = overview.kpis || {};
  const inventoryValue = kpis.inventory_value ?? 0;

  // A recommendation row carries two different vocabularies: `type` is the
  // action the engine recommends (`reorder` / `monitor` / `no_action`) and
  // `status` is the product's inventory health (`critical` / `low` / …). An
  // alert is a health state, so the filter and the urgency sort both read
  // `status` — filtering on `type` matched nothing and emptied the alert list.
  const ranked = (recommendations.items || [])
    .filter((row) => row.status === 'critical' || row.status === 'low')
    .sort(
      (a, b) =>
        URGENCY[a.status] - URGENCY[b.status] ||
        (a.current_stock ?? 0) - (b.current_stock ?? 0),
    )
    .slice(0, 6);

  const alerts = ranked.map((row) => ({
    id: row.product_id,
    name: row.product_name,
    status: row.status,
    currentStock: row.current_stock,
    reorderPoint: row.reorder_point,
    // The engine's own quantity. A product at risk with no recommended
    // quantity is reported as such rather than padded with an invented number.
    recommendedAction:
      (row.recommended_order_qty ?? 0) > 0
        ? `Reorder ${row.recommended_order_qty} units`
        : 'No reorder needed',
    severity: row.status === 'critical' ? 'critical' : 'warning',
  }));

  const activity = (audit.audit || []).map(toActivity);

  return {
    user: { ...user },
    setup: toSetupProgress({
      products: kpis.total_products ?? 0,
      salesRows: summary.total_records ?? 0,
      productsForecasted: forecast.products_forecast ?? 0,
    }),
    kpis: {
      totalProducts: kpis.total_products ?? 0,
      productsToReorder: kpis.products_to_reorder ?? 0,
      stockoutRisk: kpis.stockout_risk ?? 0,
      excessInventory: kpis.excess_inventory ?? 0,
      inventoryValue,
      totalUnits: kpis.total_units ?? 0,
    },
    health: {
      healthy: health.healthy ?? 0,
      atRisk: health.at_risk ?? 0,
      critical: health.critical ?? 0,
      total: health.total ?? 0,
    },
    chart: {
      actual: (forecast.actuals || []).map((point) => ({ date: point.date, units: point.units })),
      forecast: (forecast.points || []).map((point) => ({
        date: point.date,
        forecast: point.forecast,
        lower: point.lower,
        upper: point.upper,
      })),
    },
    period: days,
    chartPeriods: CHART_PERIODS,
    alerts,
    activity,
    alertCount: alerts.length,
    totalAlertProductCount:
      (health.critical ?? 0) + (health.at_risk ?? 0),
    currency: 'INR',
    valueLabel: formatINR(inventoryValue, { lakh: true }),
  };
}

export async function getWorkspace(user) {
  requireApiSession();
  const [overview, summary, forecast, unread] = await Promise.all([
    http.fetchTenantOverview(user),
    http.fetchSalesSummary(user),
    http.fetchPortfolioForecast(user, { horizon: 1 }),
    getUnreadCount(user),
  ]);

  return {
    user: { ...user },
    setup: toSetupProgress({
      products: overview.products ?? 0,
      salesRows: overview.sales_rows ?? 0,
      productsForecasted: forecast.products_forecast ?? 0,
    }),
    counts: {
      products: overview.products ?? 0,
      salesRecords: overview.sales_rows ?? 0,
      salesDateFrom: summary.date_from ?? null,
      salesDateTo: summary.date_to ?? null,
      unread,
    },
  };
}
