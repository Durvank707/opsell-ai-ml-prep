// Inventory simulation (V2) — evaluates replenishment policies against
// historical demand.
//
// In `api` mode this is a real backtest: one product's recorded days are
// replayed through the same replenishment helpers the live V2 recommendation
// uses, on the server, over this tenant's own sales history and error spread.
//
// In `mock` mode there is no server to call, so this file replays the same
// *rule* against the deterministic browser store: lead-time demand plus safety
// stock, reorder point reached, order topped up to that level, arrival after the
// supplier lead time. It is a demo estimate, not the production engine, and the
// results panel labels it as one — but it no longer contradicts the server, and
// it is no longer a different formula wearing the same policy names.
//
// Either way the payload is handed to `toSimulationResult`, so the results panel
// renders one shape and cannot accidentally render the two modes differently.

import { getDB, latency, randomError } from './mock/db';
import { usingApi } from './api/mode';
import * as api from './api/intelligence';
import { toSimulationResult } from './simulationResult';
import {
  COMPARABLE_POLICY_KEYS,
  CUSTOM_POLICY_FIELDS,
  CUSTOM_POLICY_KEY,
  INVENTORY_POLICIES,
  POLICY_LOOKUP,
  SIMULATION_SCOPE,
} from './simulationPolicy';

/** Mirrors `calculate_financial_metrics`'s default annual holding rate. */
const HOLDING_COST_RATE = 0.2;
/** Mirrors `moving_average_forecast`'s default window. */
const BASELINE_WINDOW = 7;
/** Mirrors `TenantWorkspace.backtest`'s default window and lead-in. */
const BACKTEST_WINDOW_DAYS = 89;
const BACKTEST_LEAD_IN_DAYS = 28;
const WEEKDAY_FACTOR = [0.9, 0.95, 0.98, 1.0, 1.05, 1.18, 1.1];

/** Two decimals, the precision the server reports its money and levels in. */
function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export async function runSimulation(user, config) {
  if (usingApi()) return api.runSimulation(user, config);
  await latency(1400);

  const db = getDB(user);
  const productIds = config.productIds || [];
  if (productIds.length === 0) {
    throw randomError('Choose a product to simulate.');
  }
  if (productIds.length > 1) {
    throw randomError(
      'Simulation evaluates one product at a time so the comparison stays ' +
        'like-for-like. Choose a single product.',
    );
  }

  const product = db.products.find((p) => p.id === productIds[0]);
  if (!product) throw randomError('That product no longer exists.');

  const payload = buildPayload(db, product, config);
  const result = toSimulationResult(payload, { ...config, mode: 'mock' });

  db.simulations = [result, ...(db.simulations || [])].slice(0, 5);
  // The activity line names what was replayed, not which one the user picked:
  // they picked none, and the run covered several.
  db.pushActivity(
    'simulation_completed',
    `Inventory simulation completed for ${product.name} across ` +
      `${result.strategies.length} inventory strategies.`,
  );
  return result;
}

// ---------------------------------------------------------------- demand series

function sortedSales(db, productId) {
  return db
    .getSales(productId)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The window the server would choose for an untouched form. */
function defaultWindow(series) {
  if (!series.length) return { start: null, end: null };
  const first = series[0].date;
  const last = series[series.length - 1].date;
  const end = last;
  const minusWindow = shiftDate(end, -(BACKTEST_WINDOW_DAYS));
  const plusLeadIn = shiftDate(first, BACKTEST_LEAD_IN_DAYS);
  return { start: minusWindow > plusLeadIn ? minusWindow : plusLeadIn, end };
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * One row per simulated day: the recorded demand, and the two forecasts that
 * could have been made for it using only the days before it.
 *
 * XGBoost is not run in the browser. The "AI" arm here is a weekday-seasonal
 * projection of the product's own average, and the baseline arm is the same
 * seven-day moving average the server's baseline uses. Both are built from
 * history strictly before the day, which is the property the comparison depends
 * on.
 */
function buildDays(db, product, start, end) {
  const series = sortedSales(db, product.id);
  const byDate = new Map(series.map((row) => [row.date, row]));

  const days = [];
  let cursor = start;
  while (cursor <= end) {
    const history = series.filter((row) => row.date < cursor);
    const recent = history.slice(-BASELINE_WINDOW).map((row) => row.units);
    const weekday = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    const sameWeekday = history
      .filter((row) => new Date(`${row.date}T00:00:00Z`).getUTCDay() === weekday)
      .map((row) => row.units);

    const recorded = byDate.get(cursor);
    const demand = recorded ? recorded.units : 0;
    const baselineDaily = history.length
      ? mean(recent)
      : product.dailyAvg;
    const xgbDaily = sameWeekday.length
      ? mean(sameWeekday) * WEEKDAY_FACTOR[weekday]
      : product.dailyAvg * WEEKDAY_FACTOR[weekday];

    days.push({
      date: cursor,
      demand,
      xgbDaily: Math.max(0, xgbDaily),
      baselineDaily: Math.max(0, baselineDaily),
      recorded: Boolean(recorded),
    });
    cursor = shiftDate(cursor, 1);
  }
  return days;
}

// ---------------------------------------------------------------- replay

/**
 * Resolve a policy key into the effective levels for one day.
 *
 * This is the browser's copy of `resolve_policy`: presets scale the configured
 * safety stock, the custom policy substitutes two explicit values, and both
 * levels are derived from lead-time demand plus safety stock. It exists because
 * mock mode has no server; it is deliberately small and pinned by a test so it
 * cannot quietly drift from the backend rule.
 */
export function resolvePolicyLevels(
  profile,
  { safetyStock, dailyForecast, leadTimeDays, custom },
) {
  const baseSafety = Math.max(0, Number(safetyStock) || 0);
  const baseCoverage = Math.max(0, (Number(dailyForecast) || 0) * leadTimeDays);

  let safety;
  let coverage;
  let coverageDays;

  if (profile.acceptsCustom) {
    const supplied = custom || {};
    safety =
      supplied.safety_stock !== undefined && supplied.safety_stock !== null
        ? Math.max(0, Number(supplied.safety_stock))
        : baseSafety;
    coverageDays =
      supplied.coverage_days !== undefined && supplied.coverage_days !== null
        ? Math.max(0, Number(supplied.coverage_days))
        : leadTimeDays;
    coverage = Math.max(0, (Number(dailyForecast) || 0) * coverageDays);
  } else {
    safety = Math.ceil(baseSafety * profile.safetyMultiplier);
    coverage = baseCoverage * profile.coverageMultiplier;
    coverageDays = leadTimeDays * profile.coverageMultiplier;
  }

  // Reorder point and order-up-to are the same level under every policy, which
  // is exactly how the production recommendation behaves.
  const reorderPoint = coverage + safety;
  return { safety, coverage, coverageDays, reorderPoint, orderUpTo: reorderPoint };
}

function replay(days, options) {
  const {
    startingStock,
    safetyStock,
    leadTimeDays,
    profile,
    custom,
    method,
  } = options;
  const forecastField = method === 'baseline' ? 'baselineDaily' : 'xgbDaily';

  let stock = Number(startingStock) || 0;
  const openOrders = [];
  const rows = [];

  for (const day of days) {
    const arriving = openOrders.filter((order) => order.arrival === day.date);
    stock += arriving.reduce((sum, order) => sum + order.qty, 0);
    if (arriving.length) {
      openOrders.splice(
        0,
        openOrders.length,
        ...openOrders.filter((order) => order.arrival !== day.date),
      );
    }

    const demand = Math.max(0, Number(day.demand) || 0);
    const fulfilled = Math.min(demand, stock);
    stock -= fulfilled;

    // Stock on hand plus everything already ordered but not yet delivered is
    // what the reorder trigger is measured against, at this same moment.
    const inTransit = openOrders.reduce((sum, order) => sum + order.qty, 0);
    const position = stock + inTransit;

    const levels = resolvePolicyLevels(profile, {
      safetyStock,
      dailyForecast: day[forecastField],
      leadTimeDays,
      custom,
    });

    const triggered = position < levels.reorderPoint;
    const orderQty = triggered
      ? Math.max(0, Math.round(levels.orderUpTo - position))
      : 0;
    if (orderQty > 0) {
      openOrders.push({ arrival: shiftDate(day.date, leadTimeDays), qty: orderQty });
    }

    rows.push({
      date: day.date,
      demand,
      opening_stock: stock + fulfilled,
      arrival_qty: arriving.reduce((sum, order) => sum + order.qty, 0),
      units_fulfilled: fulfilled,
      stockout_units: demand - fulfilled,
      closing_stock: stock,
      inventory_position: position,
      open_order_units: inTransit,
      order_qty: orderQty,
      reorder_point: levels.reorderPoint,
      target_inventory: levels.orderUpTo,
      safety_stock: levels.safety,
      coverage_days: levels.coverageDays,
      total_forecast: day[forecastField] * 30,
      recorded: day.recorded,
    });
  }

  return rows;
}

function metricsFor(rows, { unitCost, orderingCostPerOrder, stockoutCostPerUnit }) {
  const totalDemand = rows.reduce((sum, row) => sum + row.demand, 0);
  const totalFulfilled = rows.reduce((sum, row) => sum + row.units_fulfilled, 0);
  const lostSales = rows.reduce((sum, row) => sum + row.stockout_units, 0);
  const numberOfOrders = rows.filter((row) => row.order_qty > 0).length;
  const totalUnitsOrdered = rows.reduce((sum, row) => sum + row.order_qty, 0);
  const durationDays = rows.length;

  const averageInventory = mean(rows.map((row) => row.closing_stock));
  const maximumInventory = rows.reduce(
    (max, row) => Math.max(max, row.closing_stock),
    0,
  );

  const holdingCost =
    averageInventory * unitCost * HOLDING_COST_RATE * (durationDays / 365);
  const orderingCost = numberOfOrders * orderingCostPerOrder;
  const stockoutCost = lostSales * stockoutCostPerUnit;

  return {
    unit_cost: unitCost,
    duration_days: durationDays,
    total_demand: totalDemand,
    total_fulfilled: totalFulfilled,
    lost_sales_units: lostSales,
    stockout_days: rows.filter((row) => row.stockout_units > 0).length,
    number_of_orders: numberOfOrders,
    total_units_ordered: totalUnitsOrdered,
    service_level: totalDemand
      ? Math.round((totalFulfilled / totalDemand) * 10000) / 100
      : 100,
    average_inventory: Math.round(averageInventory * 100) / 100,
    maximum_inventory: maximumInventory,
    holding_cost: Math.round(holdingCost * 100) / 100,
    ordering_cost: Math.round(orderingCost * 100) / 100,
    stockout_cost: Math.round(stockoutCost * 100) / 100,
    total_inventory_cost: Math.round((holdingCost + orderingCost + stockoutCost) * 100) / 100,
  };
}

function excessAbove(rows, safetyStock) {
  const buffer = Math.max(0, Number(safetyStock) || 0);
  return mean(rows.map((row) => Math.max(0, row.closing_stock - buffer)));
}

// ---------------------------------------------------------------- validation

/**
 * The custom parameters the server accepts, checked with the server's rules.
 *
 * The demo engine has to refuse the same inputs the API refuses, or a value that
 * would be a 422 in api mode silently produces a result here — which is the
 * whole class of problem the policy layer exists to close.
 */
export function validateCustomParams(custom) {
  const supplied = custom || {};
  if (!Object.keys(supplied).length) return null;

  const unknown = Object.keys(supplied).filter(
    (key) => !CUSTOM_POLICY_FIELDS.some((field) => field.name === key),
  );
  if (unknown.length) {
    return `A custom policy accepts only safety_stock and coverage_days, but ${unknown.join(', ')} was supplied.`;
  }

  for (const field of CUSTOM_POLICY_FIELDS) {
    const value = supplied[field.name];
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return `'${field.name}' must be a number, but ${value} was supplied.`;
    }
    // Safety stock is a quantity of stock and may be zero; coverage is a
    // duration and a zero-day order would never arrive.
    const positive = field.name === 'coverage_days';
    if (positive ? number <= 0 : number < 0) {
      return positive
        ? `'${field.name}' must be greater than zero.`
        : `'${field.name}' must be zero or more.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- payload

function buildPayload(db, product, config) {
  const series = sortedSales(db, product.id);
  if (!series.length) {
    throw randomError(
      `'${product.name}' has no sales history, so there is nothing to backtest.`,
    );
  }

  const fallback = defaultWindow(series);
  const start = config.periodIsDefault ? fallback.start : config.startDate || fallback.start;
  const end = config.periodIsDefault ? fallback.end : config.endDate || fallback.end;
  if (!start || !end) throw randomError('The historical period is incomplete.');
  if (start >= end) {
    throw randomError('The historical period must start before it ends.');
  }

  const leadTimeDays = Math.max(1, Number(product.leadTimeDays) || 1);
  const safetyStock = Math.max(0, Number(product.safetyStock) || 0);
  const unitCost = Number(product.unitCost) || 0;
  const orderingCostPerOrder = Number(config.orderingCost) || 500;
  const stockoutCostPerUnit = Number(config.stockoutCost) || 1000;

  // Which strategies this run replays. Every preset always, because the user
  // picks none of them — the comparison is the point. Custom joins them when the
  // optional experiment is switched on.
  const customEnabled = Boolean(config.customEnabled);
  const requested = customEnabled
    ? [...COMPARABLE_POLICY_KEYS, CUSTOM_POLICY_KEY]
    : [...COMPARABLE_POLICY_KEYS];
  const primaryKey = customEnabled ? CUSTOM_POLICY_KEY : 'current';

  const supplied = customEnabled ? config.customParams || {} : {};
  const customError = validateCustomParams(supplied);
  if (customError) throw randomError(customError);

  const days = buildDays(db, product, start, end);
  const costs = { unitCost, orderingCostPerOrder, stockoutCostPerUnit };
  const dailyForecast = mean(days.map((day) => day.xgbDaily));

  /**
   * One strategy's own replay, metrics and comparison row.
   *
   * Every strategy is replayed against the same `days`, the same starting stock
   * and the same lead time, so the only thing that differs between the rows is
   * the strategy — which is what makes the comparison honest.
   */
  const runStrategy = (key, method = 'xgboost') => {
    const profile = POLICY_LOOKUP[key];
    const custom = profile.acceptsCustom ? supplied : {};
    const rows = replay(days, {
      startingStock: product.currentStock,
      safetyStock,
      leadTimeDays,
      profile,
      custom,
      method,
    });
    const metrics = metricsFor(rows, costs);
    const levels = resolvePolicyLevels(profile, {
      safetyStock,
      dailyForecast,
      leadTimeDays,
      custom,
    });
    return {
      rows,
      metrics,
      levels,
      row: {
        key,
        label: profile.label,
        description: profile.description,
        safety_stock: levels.safety,
        coverage_days: Math.round(levels.coverageDays * 100) / 100,
        average_reorder_point: round2(mean(rows.map((r) => r.reorder_point))),
        average_order_up_to: round2(mean(rows.map((r) => r.target_inventory))),
        stockout_days: metrics.stockout_days,
        stockout_units: metrics.lost_sales_units,
        service_level: metrics.service_level,
        average_inventory: metrics.average_inventory,
        maximum_inventory: metrics.maximum_inventory,
        excess_inventory: round2(excessAbove(rows, levels.safety)),
        number_of_orders: metrics.number_of_orders,
        total_units_ordered: metrics.total_units_ordered,
        holding_cost: metrics.holding_cost,
        ordering_cost: metrics.ordering_cost,
        stockout_cost: metrics.stockout_cost,
        total_inventory_cost: metrics.total_inventory_cost,
      },
    };
  };

  const strategyRuns = new Map(
    requested.map((key) => [key, runStrategy(key)]),
  );
  const primary = strategyRuns.get(primaryKey);
  // The forecasting arms run under the primary strategy, so the model
  // comparison isolates the model rather than mixing a strategy change in.
  const baselineRun = runStrategy(primaryKey, 'baseline');

  const policyComparison = requested.map((key) => strategyRuns.get(key).row);
  const policyTimelines = Object.fromEntries(
    requested.map((key) => [
      key,
      strategyRuns.get(key).rows.map((row) => ({
        date: row.date,
        demand: row.demand,
        arrival_qty: row.arrival_qty,
        units_fulfilled: row.units_fulfilled,
        stockout_units: row.stockout_units,
        closing_stock: row.closing_stock,
        open_order_units: row.open_order_units,
        inventory_position: row.inventory_position,
        order_qty: row.order_qty,
        reorder_required: row.order_qty > 0,
        reorder_point: round2(row.reorder_point),
        target_inventory: round2(row.target_inventory),
        safety_stock: row.safety_stock,
      })),
    ]),
  );

  const xgbMetrics = primary.metrics;
  const baselineMetrics = baselineRun.metrics;
  const costDifference =
    xgbMetrics.total_inventory_cost - baselineMetrics.total_inventory_cost;

  return {
    product_id: product.id,
    product_name: product.name,
    start_date: start,
    end_date: end,
    duration_days: days.length,
    unit_cost: unitCost,
    starting_stock: product.currentStock,
    safety_stock: safetyStock,
    forecast_error_std: Math.round((Number(product.sigma) || 0) * 1000) / 1000,
    lead_time_days: leadTimeDays,
    scope: SIMULATION_SCOPE,
    policies_evaluated: requested,
    policy: {
      key: primaryKey,
      label: POLICY_LOOKUP[primaryKey].label,
      description: POLICY_LOOKUP[primaryKey].description,
      safety_stock: primary.levels.safety,
      coverage_days: round2(primary.levels.coverageDays),
      average_reorder_point: round2(
        mean(primary.rows.map((row) => row.reorder_point)),
      ),
      average_order_up_to: round2(
        mean(primary.rows.map((row) => row.target_inventory)),
      ),
      parameters: POLICY_LOOKUP[primaryKey].acceptsCustom ? supplied : {},
    },
    policy_comparison: policyComparison,
    policy_timelines: policyTimelines,
    available_policies: INVENTORY_POLICIES.map((entry) => ({
      key: entry.key,
      label: entry.label,
      description: entry.description,
    })),
    custom_parameters: Object.fromEntries(
      CUSTOM_POLICY_FIELDS.map((field) => [field.name, field.hint]),
    ),
    xgb_metrics: xgbMetrics,
    baseline_metrics: baselineMetrics,
    // Reported for parity with the API. The results panel deliberately keeps
    // this inside the collapsed model section and does not turn it into a
    // verdict — a lower cost on one replay is not proof one forecasting method
    // is better.
    cost_comparison: {
      recommended_strategy: costDifference <= 0 ? 'xgboost' : 'baseline',
      expected_savings: Math.abs(costDifference),
      cost_difference: costDifference,
    },
    mode: 'mock',
  };
}
