// Shape adapters: canonical backend payloads -> the objects the pages consume.
//
// The backend speaks the canonical contract in `backend/contracts.py`
// (snake_case, contract field names). The UI was written against a
// deterministic in-browser store with camelCase keys. These functions are the
// single translation layer between the two, so no page or component has to know
// which source it is reading and the contract stays owned by the backend.
//
// Two rules hold throughout:
//
//   1. Nothing is invented. A value the contract does not carry is `null`, not
//      a plausible-looking guess. The UI already renders an em dash for a
//      missing number, so an honest null reads correctly instead of quietly
//      showing a fabricated figure.
//   2. Labels the engine produced are passed through untouched. `fallback_used`
//      and `eligibility` are the whole point of gating ML on data quality, so
//      a baseline forecast is never dressed up as a model forecast.

import { formatDate } from '../../lib/utils';

const HEALTH_STATES = ['critical', 'low', 'overstocked', 'healthy'];

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function boolStockoutRisk(value) {
  const level = str(value).toUpperCase();
  return level === 'HIGH' || level === 'MEDIUM';
}

function healthStatus(value) {
  const status = str(value);
  return HEALTH_STATES.includes(status) ? status : 'healthy';
}

/**
 * One product as the catalog tables and the detail page read it.
 *
 * `source` is either a `product_metrics` row or an `_inventory_state` row; the
 * inventory overview supplies the richer one, which is where `status`,
 * `target_stock` and the 30-day forecast total come from. Fields only the
 * richer row carries fall back to `null` rather than being faked.
 */
export function toProduct(source) {
  const row = source || {};
  return {
    id: str(row.product_id),
    sku: str(row.product_id),
    name: str(row.product_name) || str(row.product_id),
    category: str(row.category) || 'Uncategorised',
    description: str(row.description),
    supplier: str(row.supplier),
    unitCost: num(row.unit_cost, 0),
    sellingPrice: num(row.unit_price, 0),
    currentStock: num(row.current_stock, 0),
    // `safety_stock` is the floor the tenant sets by hand, so it is what the
    // form's "Minimum Stock" field edits. The engine's own safety-stock figure
    // is reported separately below and is only used when the tenant set none.
    minStock: num(row.safety_stock, 0),
    openOrderQty: num(row.open_order_qty, 0),
    expectedArrival: row.expected_arrival_date ? str(row.expected_arrival_date) : null,
    leadTimeDays: num(row.lead_time_days, 0),
    dailyAvg: num(row.daily_avg, 0),
    // The inventory overview is the one read that carries a 30-day total, which
    // is what keeps the catalog table from needing a forecast call per row.
    forecast30: num(row.forecast_total, null),
    forecast30AvgDaily: num(row.forecast_avg_daily, null),
    leadTimeDemand: num(row.lead_time_demand, 0),
    sigma: num(row.forecast_error_std ?? row.error_std, 0),
    safetyStock: num(row.safety_stock, 0),
    reorderPoint: num(row.reorder_point, 0),
    targetStock: num(row.target_stock, null),
    status: healthStatus(row.status),
    stockoutRisk: boolStockoutRisk(row.stockout_risk),
    inventoryPosition: num(row.inventory_position, 0),
    daysOfInventory: num(row.days_covered, 0),
    createdAt: str(row.updated_at),
    updatedAt: str(row.updated_at),
    // Provenance, surfaced so a page can label a baseline as a baseline.
    historyDays: num(row.history_days, 0),
    fallbackUsed: row.fallback_used ?? null,
    modelVersion: row.model_version ?? null,
    eligibility: row.eligibility ?? null,
    metricsError: row.error ?? null,
  };
}

/** One product's demand forecast, as the forecast chart reads it. */
export function toForecast(raw) {
  const row = raw || {};
  return {
    productId: str(row.product_id),
    productName: str(row.product_name),
    category: str(row.category),
    horizon: num(row.horizon, 0),
    points: (row.points || []).map((point) => ({
      date: str(point.date),
      forecast: num(point.forecast, 0),
      lower: num(point.lower, 0),
      upper: num(point.upper, 0),
    })),
    actuals: (row.actuals || []).map((point) => ({
      date: str(point.date),
      units: num(point.units, 0),
    })),
    total: num(row.total, 0),
    avgDaily: num(row.avg_daily, 0),
    peakDate: row.peak_date ? str(row.peak_date) : null,
    peakUnits: num(row.peak_units, null),
    trend: str(row.trend) || 'stable',
    growthPct: num(row.growth_pct, 0),
    fallbackUsed: row.fallback_used ?? null,
    modelVersion: row.model_version ?? null,
    eligibility: row.eligibility ?? null,
    warning: row.warning ?? null,
    mlUnavailable: Boolean(row.ml_unavailable),
  };
}

/** The portfolio forecast, as the forecast overview reads it. */
export function toPortfolioForecast(raw) {
  const row = raw || {};
  return {
    horizon: num(row.horizon, 0),
    scope: str(row.scope) || 'portfolio',
    category: row.category ?? null,
    points: (row.points || []).map((point) => ({
      date: str(point.date),
      forecast: num(point.forecast, 0),
      lower: num(point.lower, 0),
      upper: num(point.upper, 0),
    })),
    actuals: (row.actuals || []).map((point) => ({
      date: str(point.date),
      units: num(point.units, 0),
    })),
    total: num(row.total, 0),
    avgDaily: num(row.avg_daily, 0),
    rows: (row.rows || []).map((entry) => ({
      id: str(entry.product_id),
      name: str(entry.product_name),
      category: str(entry.category),
      current: num(entry.current_daily_avg, 0),
      forecast: num(entry.forecast_total, 0),
      forecastAvgDaily: num(entry.forecast_avg_daily, 0),
      changePct: num(entry.change_pct, 0),
      trend: str(entry.trend) || 'stable',
      totalForecast: num(entry.forecast_total, 0),
      fallbackUsed: entry.fallback_used ?? null,
    })),
    increasing: num(row.increasing, 0),
    decreasing: num(row.decreasing, 0),
    stable: num(row.stable, 0),
    productsForecasted: num(row.products_forecast, 0),
    productsInScope: num(row.products_in_scope, 0),
    portfolioTrend: str(row.portfolio_trend) || 'stable',
    mlUnavailableCount: num(row.ml_unavailable_count, 0),
  };
}

/** Portfolio inventory KPIs, health buckets and category split. */
export function toInventoryOverview(raw) {
  const row = raw || {};
  const kpis = row.kpis || {};
  const health = row.health || {};
  const buckets = row.buckets || {};
  const inventoryValue = num(kpis.inventory_value, 0);
  return {
    kpis: {
      totalProducts: num(kpis.total_products, 0),
      productsToReorder: num(kpis.products_to_reorder, 0),
      stockoutRisk: num(kpis.stockout_risk, 0),
      excessInventory: num(kpis.excess_inventory, 0),
      inventoryValue,
      inventoryValueLabel: formatLakh(inventoryValue),
      totalUnits: num(kpis.total_units, 0),
    },
    health: {
      healthy: num(health.healthy, 0),
      atRisk: num(health.at_risk, 0),
      critical: num(health.critical, 0),
      total: num(health.total, 0),
    },
    critical: (buckets.critical || []).map(toProduct),
    low: (buckets.low || []).map(toProduct),
    overstocked: (buckets.overstocked || []).map(toProduct),
    // The healthy bucket is part of the shape the mock returns and the catalog
    // table is assembled from all four, so omitting it here silently emptied
    // the product list.
    healthy: (buckets.healthy || []).map(toProduct),
    categories: (row.categories || []).map((entry) => ({
      name: str(entry.category),
      products: num(entry.products, 0),
      units: num(entry.units, 0),
      value: num(entry.value, 0),
      critical: num(entry.critical, 0),
    })),
    mlUnavailableCount: num(row.ml_unavailable_count, 0),
  };
}

function formatLakh(value) {
  const n = Number(value) || 0;
  if (n >= 10000000) return `${(n / 10000000).toFixed(2)}Cr`;
  return `${(n / 100000).toFixed(1)}L`;
}

/**
 * The stock projection behind the inventory timeline chart.
 *
 * The series is `days` of forward projection preceded by a week of recorded
 * history, so the chart shows the demand that led into the projection rather
 * than starting mid-air.
 */
export function toTimeline(raw) {
  const row = raw || {};
  return {
    productId: str(row.product_id),
    productName: str(row.product_name),
    // The backend projects both paths from the same demand series, so the
    // "with a reorder" and "never reorder" lines are the real comparison the
    // page draws rather than a second estimate.
    points: (row.points || []).map((point) => ({
      date: str(point.date),
      stock: num(point.stock, 0),
      stockWithoutReorder: num(point.stock_without_reorder, 0),
      demand: num(point.demand, 0),
    })),
    currentStock: num(row.current_stock, 0),
    inventoryPosition: num(row.inventory_position, num(row.current_stock, 0)),
    reorderPoint: num(row.reorder_point, 0),
    safetyStock: num(row.safety_stock, 0),
    targetStock: num(row.target_stock, 0),
    status: healthStatus(row.status),
    expectedDepletion: row.expected_depletion ? str(row.expected_depletion) : null,
    reorderPlacedOn: row.reorder_placed_on ? str(row.reorder_placed_on) : null,
    pastAverage: num(row.past_average, 0),
    daysOfCover: num(row.days_of_cover, null),
  };
}

/** One row of the portfolio-wide recommendation list. */
export function toRecommendation(raw) {
  const row = raw || {};
  return {
    id: str(row.product_id),
    productId: str(row.product_id),
    name: str(row.product_name),
    category: str(row.category),
    type: str(row.type) || 'no_action',
    title: str(row.title),
    reason: str(row.reason),
    actionLabel: str(row.action_label),
    currentStock: num(row.current_stock, 0),
    inventoryPosition: num(row.inventory_position, 0),
    reorderPoint: num(row.reorder_point, 0),
    safetyStock: num(row.safety_stock, 0),
    leadTimeDays: num(row.lead_time_days, 0),
    projectedDemand: num(row.projected_demand, 0),
    dailyDemand: num(row.daily_demand, 0),
    recommendedOrder: num(row.recommended_order_qty, 0),
    reorderRequired: Boolean(row.reorder_required),
    stockoutRisk: boolStockoutRisk(row.stockout_risk),
    growthPct: num(row.growth_pct, 0),
    lastUpdated: str(row.last_updated),
    status: healthStatus(row.status),
    fallbackUsed: row.fallback_used ?? null,
    eligibility: row.eligibility ?? null,
  };
}

/** Portfolio sales totals. */
export function toSalesSummary(raw) {
  const row = raw || {};
  return {
    totalRecords: num(row.total_records, 0),
    totalUnits: num(row.total_units, 0),
    totalRevenue: num(row.total_revenue, 0),
    lastImport: null,
    productsCovered: num(row.products_covered, 0),
    dateFrom: row.date_from ? str(row.date_from) : null,
    dateTo: row.date_to ? str(row.date_to) : null,
    // The canonical sales contract records no channel, so there is no
    // by-channel split to report. An empty list keeps the page's existing
    // empty state instead of inventing one.
    channels: [],
  };
}

/** One row of the sales records table. */
export function toSalesRecord(row) {
  const record = row || {};
  return {
    id: `${str(record.product_id)}-${str(record.date)}`,
    date: str(record.date),
    productId: str(record.product_id),
    productName: str(record.product_name) || str(record.product_id),
    category: str(record.category),
    units: num(record.units_sold, 0),
    revenue: num(record.price, null) === null
      ? null
      : Math.round(num(record.units_sold, 0) * num(record.price, 0) * 100) / 100,
    channel: null,
    promotion: record.promotion ?? null,
  };
}

/** One audit entry as an activity-feed item. */
export function toActivity(entry) {
  const row = entry || {};
  const time = str(row.created_at);
  return {
    id: str(row.id),
    type: str(row.action),
    title: ACTIVITY_TITLES[str(row.action)] || humanize(str(row.action)),
    description: describeAudit(row),
    time,
    label: formatDate(time, { month: 'short' }),
    severity: ACTIVITY_SEVERITY[str(row.action)] || 'info',
  };
}

function humanize(action) {
  const text = String(action || '').replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Activity';
}

// Every action the tenant workspace actually writes. Kept explicit so a new
// backend action is visible here as a missing title rather than silently
// rendering as a raw snake_case string.
const ACTIVITY_TITLES = {
  product_upserted: 'Product saved',
  product_deleted: 'Product removed',
  sales_upserted: 'Sales recorded',
  forecast_generated: 'Forecast generated',
  forecast_ml_failed: 'Forecast used a baseline',
  metrics_recomputed: 'Metrics recomputed',
  simulation_backtested: 'Simulation completed',
};

const ACTIVITY_SEVERITY = {
  product_upserted: 'success',
  product_deleted: 'warning',
  sales_upserted: 'info',
  forecast_generated: 'success',
  forecast_ml_failed: 'warning',
  metrics_recomputed: 'info',
  simulation_backtested: 'success',
};

function describeAudit(row) {
  const detail = row.detail && typeof row.detail === 'object' ? row.detail : {};
  const productId = str(row.product_id);
  const suffix = productId ? ` (${productId})` : '';
  const action = str(row.action);

  if (action === 'product_deleted') {
    const removed = num(detail.sales_rows_removed, 0);
    const name = str(detail.product_name) || productId;
    return `Removed ${name} and its ${removed} sales row${removed === 1 ? '' : 's'}.`;
  }
  if (action === 'product_upserted') {
    return `Saved with ${num(detail.current_stock, 0)} units on hand${suffix}.`;
  }
  if (action === 'sales_upserted') {
    const units = num(detail.units_sold, 0);
    const date = str(detail.date);
    const verb = detail.was_update ? 'Updated' : 'Recorded';
    return `${verb} ${units} unit${units === 1 ? '' : 's'} on ${date || 'an unknown date'}${suffix}.`;
  }
  if (action === 'forecast_generated') {
    const rows = num(detail.forecast_rows, 0);
    const used = str(detail.fallback_used);
    const source = used === 'baseline' ? 'a baseline estimate' : 'the demand model';
    return `Produced ${rows} day${rows === 1 ? '' : 's'} from ${source}${suffix}.`;
  }
  if (action === 'forecast_ml_failed') {
    const affected = num(detail.affected_products, null);
    if (affected !== null) {
      return `${affected} product${affected === 1 ? '' : 's'} fell back to a baseline forecast.`;
    }
    return `The model could not be used${suffix}; a labeled baseline was used instead.`;
  }
  if (action === 'metrics_recomputed') {
    return `Stockout risk is ${str(detail.stockout_risk).toLowerCase() || 'unknown'}${suffix}.`;
  }
  if (action === 'simulation_backtested') {
    const days = num(detail.duration_days, 0);
    return `Backtested ${str(detail.recommended_strategy) || 'a policy'} over ${days} days${suffix}.`;
  }
  return `Recorded on the tenant audit trail${suffix}.`;
}

/** The three-step onboarding checklist. */
export function toSetupProgress({ products = 0, salesRows = 0, productsForecasted = 0 } = {}) {
  const steps = [
    {
      key: 'products',
      title: 'Add Products',
      description: 'Add your products and inventory information.',
      complete: products > 0,
      url: '/app/products',
    },
    {
      key: 'sales',
      title: 'Import Sales Data',
      description: 'Upload historical sales data so EcomAI-OS can understand demand.',
      complete: salesRows > 0,
      url: '/app/sales',
    },
    {
      key: 'forecast',
      title: 'Generate Forecast',
      description: 'Run your first demand forecast after enough sales history is available.',
      // Complete only once the engine has actually produced a forecast for at
      // least one product, so this can never tick itself off from an empty
      // catalog the way a stored "has run" flag could.
      complete: productsForecasted > 0,
      url: '/app/forecast',
    },
  ];
  return {
    steps,
    completed: steps.filter((step) => step.complete).length,
    total: steps.length,
    complete: steps.every((step) => step.complete),
  };
}
