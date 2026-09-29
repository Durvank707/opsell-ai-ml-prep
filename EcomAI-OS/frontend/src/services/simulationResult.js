// Shape the simulation response for the results panel.
//
// The server already answers the questions the page asks: which policy was run
// and with what effective numbers, how it would have performed, how the three
// standard policies compare, and how the two forecasting methods compare. This
// module only picks those fields out and writes the plain-English sentences
// around them — it never recomputes a replenishment decision, and it never
// invents a metric the server did not report.
//
// Both the API client and the browser-only demo data source go through here, so
// the results panel cannot tell them apart and cannot render one of them
// incorrectly.

import {
  CUSTOM_POLICY_FIELDS,
  FORECAST_METHODS,
  INVENTORY_POLICIES,
  SIMULATION_DISCLAIMER,
  SIMULATION_SCOPE,
  policyLabel,
} from './simulationPolicy';

/** Units of stock held above the safety buffer, averaged over the days shown. */
export function meanExcessAbove(trajectory, closingStockField, safetyStock) {
  const buffer = Math.max(0, Number(safetyStock) || 0);
  if (!trajectory.length) return 0;
  const total = trajectory.reduce(
    (sum, point) => sum + Math.max(0, (Number(point[closingStockField]) || 0) - buffer),
    0,
  );
  return total / trajectory.length;
}

/**
 * Stockout events, read off the daily series. The metrics block counts stockout
 * *days*; the panel also asks how many separate episodes those days fell into,
 * which is a property of the series and not of the totals.
 */
function stockoutProfile(trajectory, metrics) {
  const reportedDays = metrics.stockout_days ?? 0;
  let events = 0;
  let days = 0;
  let inRun = false;

  for (const point of trajectory) {
    if ((Number(point.xgb_stockout_units) || 0) > 0) {
      days += 1;
      if (!inRun) {
        events += 1;
        inRun = true;
      }
    } else {
      inRun = false;
    }
  }
  if (days === 0) events = reportedDays;

  return {
    events,
    days: Math.max(days, reportedDays),
    avgDuration: events > 0 ? Math.round((Math.max(days, reportedDays) / events) * 10) / 10 : 0,
  };
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The headline sentence, built only from numbers the server reported. */
export function summarise({ stockoutDays, averageInventory }) {
  const days = Number.isFinite(stockoutDays) ? stockoutDays : 0;
  const average = Number.isFinite(averageInventory) ? Math.round(averageInventory) : 0;
  const stockoutPhrase =
    days === 0
      ? 'no stockout days'
      : `${plural(days, 'stockout day')}`;
  return (
    `Over the selected historical period, this policy would have experienced ` +
    `${stockoutPhrase} and carried an average of ${average} units of inventory.`
  );
}

function policyRow(row) {
  return {
    key: row.key,
    label: row.label || policyLabel(row.key),
    description: row.description || '',
    safetyStock: row.safety_stock ?? 0,
    coverageDays: row.coverage_days ?? null,
    reorderPoint: row.average_reorder_point ?? 0,
    orderUpTo: row.average_order_up_to ?? 0,
    stockoutDays: row.stockout_days ?? 0,
    stockoutUnits: row.stockout_units ?? 0,
    serviceLevel: row.service_level ?? 0,
    averageInventory: row.average_inventory ?? 0,
    excessInventory: row.excess_inventory ?? 0,
    orders: row.number_of_orders ?? 0,
    unitsOrdered: row.total_units_ordered ?? 0,
    inventoryCost: row.total_inventory_cost ?? 0,
  };
}

function methodRow(key, label, description, metrics, excess) {
  return {
    key,
    label,
    description,
    stockoutDays: metrics.stockout_days ?? 0,
    stockoutUnits: metrics.lost_sales_units ?? 0,
    serviceLevel: metrics.service_level ?? 0,
    averageInventory: metrics.average_inventory ?? 0,
    excessInventory: Math.round(excess),
    orders: metrics.number_of_orders ?? 0,
    inventoryCost: metrics.total_inventory_cost ?? 0,
  };
}

/**
 * What the effective policy looked like, from the two sources that can supply
 * it: the resolved policy the server ran, and the catalogue the form is built
 * from. The numbers always come from the response.
 */
function effectivePolicy(payload) {
  const policy = payload.policy || {};
  const key = policy.key || 'current';
  const known = INVENTORY_POLICIES.find((entry) => entry.key === key);
  const parameters = policy.parameters || {};

  return {
    key,
    label: policy.label || known?.label || policyLabel(key),
    description: policy.description || known?.description || '',
    safetyStock: policy.safety_stock ?? payload.safety_stock ?? 0,
    coverageDays: policy.coverage_days ?? null,
    averageReorderPoint: policy.average_reorder_point ?? 0,
    averageOrderUpTo: policy.average_order_up_to ?? 0,
    parameters: CUSTOM_POLICY_FIELDS.filter(
      (field) => parameters[field.name] !== undefined && parameters[field.name] !== null,
    ).map((field) => ({
      name: field.name,
      label: field.label,
      value: parameters[field.name],
      hint: field.hint,
    })),
  };
}

/** Which policy parameter values a user can read off the results panel. */
export function effectivePolicySummary(policy) {
  const parts = [`Safety stock ${Math.round(policy.safetyStock)} units`];
  if (policy.coverageDays) parts.push(`covering ${policy.coverageDays} days of demand`);
  if (policy.averageReorderPoint) {
    parts.push(`reordering at about ${Math.round(policy.averageReorderPoint)} units`);
  }
  return parts.join(', ') + '.';
}

export function toSimulationResult(payload, config = {}) {
  const trajectory = payload.daily_trajectory || [];
  const xgb = payload.xgb_metrics || {};
  const baseline = payload.baseline_metrics || {};
  const policy = effectivePolicy(payload);
  const safetyStock = Number(policy.safetyStock) || 0;

  const xgbExcess = meanExcessAbove(trajectory, 'xgb_closing_stock', safetyStock);
  const baselineExcess = meanExcessAbove(trajectory, 'baseline_closing_stock', safetyStock);
  const stockout = stockoutProfile(trajectory, xgb);

  const xgbRow = methodRow(
    'xgboost',
    FORECAST_METHODS[0].label,
    FORECAST_METHODS[0].description,
    xgb,
    xgbExcess,
  );
  const baselineRow = methodRow(
    'baseline',
    FORECAST_METHODS[1].label,
    FORECAST_METHODS[1].description,
    baseline,
    baselineExcess,
  );

  const policyRows = (payload.policy_comparison || []).map(policyRow);

  return {
    scope: payload.scope || SIMULATION_SCOPE,
    disclaimer: SIMULATION_DISCLAIMER,
    mode: config.mode || payload.mode || 'api',
    productId: payload.product_id,
    productName: payload.product_name,
    start: payload.start_date,
    end: payload.end_date,
    durationDays: payload.duration_days,
    leadTimeDays: payload.lead_time_days,
    startingStock: payload.starting_stock,
    safetyStock: payload.safety_stock,
    forecastErrorStd: payload.forecast_error_std,
    unitCost: payload.unit_cost,
    policy,
    policyHint: effectivePolicySummary(policy),
    policyComparison: policyRows,
    forecastComparison: [xgbRow, baselineRow],
    summary: summarise({
      stockoutDays: xgb.stockout_days,
      averageInventory: xgb.average_inventory,
    }),
    kpis: {
      stockoutDays: xgb.stockout_days ?? 0,
      stockoutUnits: xgb.lost_sales_units ?? 0,
      serviceLevel: xgb.service_level ?? 0,
      averageInventory: Math.round(xgb.average_inventory ?? 0),
      excessInventory: Math.round(xgbExcess),
      orders: xgb.number_of_orders ?? 0,
      unitsOrdered: xgb.total_units_ordered ?? 0,
      inventoryCost: xgb.total_inventory_cost ?? 0,
      holdingCost: xgb.holding_cost ?? 0,
      orderingCost: xgb.ordering_cost ?? 0,
      stockoutCost: xgb.stockout_cost ?? 0,
    },
    stockout: {
      events: stockout.events,
      days: stockout.days,
      averageDuration: stockout.avgDuration,
      // A backtest replays one product, so the list of products that stocked
      // out is either that product or nobody.
      productName: payload.product_name,
    },
    chart: trajectory.map((point) => ({
      date: point.date,
      stock: point.xgb_closing_stock,
      baselineStock: point.baseline_closing_stock,
      inTransit: point.xgb_open_order_units ?? 0,
      reorderPoint: point.xgb_reorder_point ?? null,
    })),
    generatedAt: new Date().toISOString(),
  };
}
