// Shape the simulation response for the results panel.
//
// The server already answers the questions the page asks: which strategies were
// replayed, how each of them would have performed, and what each one's
// day-by-day history looked like. This module only picks those fields out and
// writes the plain-English sentences around them — it never recomputes a
// replenishment decision, it never invents a metric the server did not report,
// and it never ranks the strategies against each other.
//
// Both the API client and the browser-only demo data source go through here, so
// the results panel cannot tell them apart and cannot render one of them
// incorrectly.

import {
  CUSTOM_POLICY_FIELDS,
  FORECAST_METHODS,
  MODEL_DETAILS_MEANING,
  MODEL_DETAILS_NOTE,
  POLICY_COMPARISON_NOTE,
  POLICY_TABS_NOTE,
  SIMULATION_DISCLAIMER,
  SIMULATION_SCOPE,
  policyLabel,
} from './simulationPolicy';
import { plural } from '../lib/utils';

/** Units of stock held above the safety buffer, averaged over the days shown. */
export function meanExcessAbove(trajectory, safetyStock) {
  const buffer = Math.max(0, Number(safetyStock) || 0);
  if (!trajectory || !trajectory.length) return 0;
  const total = trajectory.reduce(
    (sum, point) => sum + Math.max(0, (Number(point.closing_stock) || 0) - buffer),
    0,
  );
  return total / trajectory.length;
}

/**
 * Stockout episodes, read off one strategy's daily series.
 *
 * The series is authoritative, because it is the same data the graph draws: a
 * text figure that disagreed with the visible line would be worse than no
 * figure. The reported total is only consulted when the series contains no
 * stockout at all, which is the one case where the series cannot say — a
 * response that summarised a window without shipping its days.
 */
function stockoutProfile(trajectory, metrics) {
  const reportedDays = Number(metrics.stockoutDays) || 0;
  let events = 0;
  let days = 0;
  let inRun = false;

  for (const point of trajectory || []) {
    if ((Number(point.stockout_units) || 0) > 0) {
      days += 1;
      if (!inRun) {
        events += 1;
        inRun = true;
      }
    } else {
      inRun = false;
    }
  }
  // A series that saw no stockout is not proof there were none: fall back to the
  // total rather than claiming a clean run the engine never reported.
  if (days === 0) return { events: reportedDays, days: reportedDays, avgDuration: 0 };

  return {
    events,
    days,
    avgDuration: Math.round((days / events) * 10) / 10,
  };
}

function range(values, round = Math.round) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  return { min: round(Math.min(...numbers)), max: round(Math.max(...numbers)) };
}

/**
 * The headline sentence: what the replay covered, and how far apart the
 * strategies landed.
 *
 * Deliberately comparative and deliberately even-handed. A sentence naming one
 * strategy in isolation would be a recommendation the backtest cannot make, and
 * a "best" reading is exactly the thing a historical replay has no business
 * implying.
 */
export function summarise({ durationDays, strategies, productName }) {
  const days = Number.isFinite(durationDays) ? durationDays : 0;
  const count = strategies.length;
  const who = productName ? `${productName}, ` : '';
  const subjects = count === 1 ? '1 strategy' : plural(count, 'strategy');
  const verb = count === 1 ? 'was' : 'were';

  if (!count) {
    return `No inventory strategy was replayed over the ${days} recorded days.`;
  }

  const stockouts = range(strategies.map((row) => row.stockoutDays));
  const inventory = range(strategies.map((row) => row.averageInventory));
  const service = range(strategies.map((row) => row.serviceLevel), (n) => Math.round(n * 10) / 10);

  const parts = [];
  if (stockouts) {
    parts.push(
      stockouts.min === stockouts.max
        ? // "no stockout days" is the phrasing a reader scans for; "0 stockout
          // days" is technically identical and reads like a column header.
          stockouts.min === 0
          ? 'no stockout days'
          : plural(stockouts.min, 'stockout day')
        : `stockouts ranged from ${stockouts.min} to ${stockouts.max} days`,
    );
  }
  if (inventory) {
    parts.push(
      inventory.min === inventory.max
        ? `an average of ${inventory.min} units held`
        : `average inventory ranged from ${inventory.min} to ${inventory.max} units`,
    );
  }
  if (service) {
    parts.push(
      service.min === service.max
        ? `service level ${service.min}%`
        : `service level ranged from ${service.min}% to ${service.max}%`,
    );
  }

  return (
    `Over the ${days} recorded days of ${who}${subjects} ${verb} replayed against ` +
    `the same demand${parts.length ? `, where ${parts.join(', ')}` : ''}.`
  );
}

/** The custom parameters a run actually applied, for the results panel. */
function appliedParameters(parameters) {
  return CUSTOM_POLICY_FIELDS.filter(
    (field) =>
      parameters[field.name] !== undefined && parameters[field.name] !== null,
  ).map((field) => ({
    name: field.name,
    label: field.label,
    value: parameters[field.name],
    hint: field.hint,
  }));
}

function toChartPoint(point) {
  return {
    date: point.date,
    // The main line: what was actually on hand at the end of each day.
    stock: Number(point.closing_stock) || 0,
    // Bought but not yet delivered, so a dip in stock is not mistaken for a
    // strategy that simply stopped ordering.
    inTransit: Number(point.open_order_units) || 0,
    // Reorder activity, so the day a top-up was triggered is visible.
    orderQty: Number(point.order_qty) || 0,
    arrivalQty: Number(point.arrival_qty) || 0,
    reorderPoint: point.reorder_point ?? null,
    demand: Number(point.demand) || 0,
    fulfilled: Number(point.units_fulfilled) || 0,
    // Drawn as a marked band: the days demand could not be met.
    lost: Number(point.stockout_units) || 0,
  };
}

function policyStrategy(row, timeline) {
  const points = timeline || [];
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
    maximumInventory: row.maximum_inventory ?? 0,
    excessInventory: row.excess_inventory ?? 0,
    orders: row.number_of_orders ?? 0,
    unitsOrdered: row.total_units_ordered ?? 0,
    holdingCost: row.holding_cost ?? 0,
    orderingCost: row.ordering_cost ?? 0,
    stockoutCost: row.stockout_cost ?? 0,
    inventoryCost: row.total_inventory_cost ?? 0,
    stockout: stockoutProfile(points, { stockoutDays: row.stockout_days ?? 0 }),
    chart: points.map(toChartPoint),
  };
}

function methodRow(key, metrics) {
  const known = FORECAST_METHODS.find((entry) => entry.key === key);
  return {
    key,
    label: known?.label || key,
    description: known?.description || '',
    stockoutDays: metrics.stockout_days ?? 0,
    stockoutUnits: metrics.lost_sales_units ?? 0,
    serviceLevel: metrics.service_level ?? 0,
    averageInventory: metrics.average_inventory ?? 0,
    orders: metrics.number_of_orders ?? 0,
    inventoryCost: metrics.total_inventory_cost ?? 0,
  };
}

/**
 * The strategy the panel opens on.
 *
 * Whatever the server listed first, so the panel agrees with the order of the
 * comparison table above it. It is a *display* default, not a choice the user
 * made: the tabs switch between strategies the run already returned.
 */
function openingKey(strategies, payload) {
  const available = new Set(strategies.map((row) => row.key));
  const primary = payload.policy?.key;
  if (primary && available.has(primary)) return primary;
  return strategies[0]?.key ?? null;
}

export function toSimulationResult(payload, config = {}) {
  const timelines = payload.policy_timelines || {};
  const comparison = payload.policy_comparison || [];

  // One row per strategy the engine actually replayed, each carrying its own
  // history. A strategy with no timeline is still listed — the server ran it and
  // reported the numbers — but the panel will say the timeline is unavailable
  // rather than charting a different strategy's line under its name.
  const strategies = comparison.map((row) =>
    policyStrategy(row, timelines[row.key] || []),
  );
  const byKey = Object.fromEntries(strategies.map((row) => [row.key, row]));
  const primaryKey = openingKey(strategies, payload);

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

    // Every strategy in the run, in the order the server listed them. `custom`
    // is here only when the server replayed it.
    strategies,
    strategiesByKey: byKey,
    initialPolicyKey: primaryKey,
    hasCustom: strategies.some((row) => row.key === 'custom'),
    // What the custom arm was actually run with, as field descriptors. Empty
    // unless a custom policy was part of the run.
    customParameters: payload.policy?.parameters || {},
    // Which strategies to draw a tab for. The same list as the comparison, so
    // the tabs and the table can never disagree about what was simulated.
    tabKeys: strategies.map((row) => row.key),
    comparisonNote: POLICY_COMPARISON_NOTE,
    tabsNote: POLICY_TABS_NOTE,

    summary: summarise({
      durationDays: payload.duration_days,
      strategies,
      productName: payload.product_name,
    }),

    /**
     * Forecasting evaluation, kept apart from the inventory result on purpose.
     *
     * EcomAI-OS chooses the forecast model, so this is not a choice the customer
     * made and not a strategy to adopt. It stays available for evaluation, which
     * is why the panel renders it inside a collapsed section the user never has
     * to open to use Simulation.
     *
     * No per-method excess inventory: the server computes excess per *policy*,
     * and one arm having a value while the other did not would compare two
     * different measurements under one column heading.
     */
    modelDetails: {
      note: MODEL_DETAILS_NOTE,
      meaning: MODEL_DETAILS_MEANING,
      methods: [methodRow('xgboost', payload.xgb_metrics || {}), methodRow('baseline', payload.baseline_metrics || {})],
      primaryKey,
    },

    generatedAt: new Date().toISOString(),
  };
}

/**
 * The custom parameters this run actually applied.
 *
 * The server reports them on the primary policy, which is the custom one
 * whenever a custom run was requested. Empty for a preset-only run, because a
 * preset has nothing to set — and the panel says so rather than printing an
 * empty list that reads like a missing value.
 */
export function appliedCustomParameters(result) {
  const parameters = result?.customParameters || {};
  return CUSTOM_POLICY_FIELDS.filter(
    (field) =>
      parameters[field.name] !== undefined && parameters[field.name] !== null,
  ).map((field) => ({
    name: field.name,
    label: field.label,
    value: parameters[field.name],
    hint: field.hint,
  }));
}
