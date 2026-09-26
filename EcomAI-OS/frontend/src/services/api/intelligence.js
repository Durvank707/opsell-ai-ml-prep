// Portfolio intelligence: recommendations and the policy backtest, backed by the
// tenant API.
//
// The recommendation rows and the backtest both come from the same engines the
// inventory page reads, so a recommendation can never disagree with the numbers
// printed beside it.

import * as http from './http';
import { toRecommendation } from './adapters';

// ---------------------------------------------------------------- recommendations

export async function getRecommendations(user, { filter = 'all', category = null } = {}) {
  const raw = await http.fetchRecommendations(user, category);
  const all = (raw.items || []).map(toRecommendation);
  const counts = raw.counts || countByType(all);

  // A category the workspace does not have is refused by the server rather
  // than answered with an empty list, so an empty result here always means
  // "nothing in this filter needs action", never "that filter matched nothing".
  const filtered = filter === 'all' ? all : all.filter((row) => row.type === filter);
  return { items: filtered, counts, total: filtered.length, filter };
}

function countByType(items) {
  return {
    all: items.length,
    critical: items.filter((r) => r.type === 'critical').length,
    reorder: items.filter((r) => r.type === 'reorder').length,
    monitor: items.filter((r) => r.type === 'monitor').length,
    no_action: items.filter((r) => r.type === 'no_action').length,
  };
}

// ---------------------------------------------------------------- simulation

const POLICY_LABELS = {
  xgboost: 'AI Policy (XGBoost)',
  baseline: 'Moving-Average Baseline',
};

/**
 * Backtest the ML replenishment policy against a moving-average baseline.
 *
 * The server runs this over one product's own history, so a scope wider than a
 * single product is refused rather than quietly simulated against one of them.
 * The comparison is therefore the real one: two policies, same demand, same
 * costs.
 */
export async function runSimulation(user, config) {
  const productId = resolveProductId(config);
  if (!productId) {
    throw new Error('Select at least one product to simulate.');
  }

  const result = await http.postBacktest(user, {
    product_id: productId,
    // An untouched period is left to the server, which derives the window from
    // this tenant's own history and reserves the lead-in the engine needs to
    // estimate a starting stock. Only a period the user actually chose is sent.
    start_date: config.periodIsDefault ? null : config.startDate || null,
    end_date: config.periodIsDefault ? null : config.endDate || null,
    ordering_cost_per_order: Number(config.orderingCost) || 500,
    stockout_cost_per_unit: Number(config.stockoutCost) || 1000,
  });

  return toSimulationResult(result, config);
}

function resolveProductId(config) {
  if (config.productSelection === 'all') {
    throw new Error(
      'The backtest runs against one product at a time so the comparison stays ' +
        'like-for-like. Choose a specific product instead of the whole catalog.',
    );
  }
  const ids = config.productIds || [];
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) {
    throw new Error('Choose a single product to simulate.');
  }
  return null;
}

/**
 * Stockout events, read off the daily trajectory.
 *
 * The metrics block reports a count of stockout *days* and a count of lost
 * units, but the results panel asks how many separate stockouts those days fell
 * into and how long each lasted. The trajectory carries the lost units for each
 * day, so consecutive days are grouped into runs and the runs counted. If there
 * is no trajectory to read, the server's own day count is reported as-is rather
 * than an event structure being invented around it.
 */
function stockoutProfile(trajectory, metrics, product) {
  const reportedDays = metrics.stockout_days ?? 0;
  const lostUnits = metrics.lost_sales_units ?? 0;

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
  if (days === 0) {
    events = reportedDays;
    days = reportedDays;
  }

  return {
    events,
    avgDuration: events > 0 ? Math.round(days / events) : 0,
    // A backtest covers one product, so the list of products that stocked out
    // is either that product or nobody.
    productsAffected: lostUnits > 0 || reportedDays > 0
      ? [
          {
            productId: product.product_id,
            name: product.product_name,
            stockoutEvents: events,
            stockoutUnits: lostUnits,
          },
        ]
      : [],
  };
}

/**
 * Mean stock held above the safety buffer, across the simulated days of one
 * policy. Excess is measured against this product's own safety stock, which the
 * response carries, so every "excess" figure on the results page is the same
 * measure read off the simulated position rather than a made-up target or, as
 * `average_inventory` would be, the total stock on hand.
 */
function meanExcessAbove(trajectory, closingStockField, safetyStock) {
  const buffer = Math.max(0, Number(safetyStock) || 0);
  let total = 0;
  for (const point of trajectory) {
    total += Math.max(0, (Number(point[closingStockField]) || 0) - buffer);
  }
  return trajectory.length > 0 ? total / trajectory.length : 0;
}

/** The excess panel's per-product rows. A backtest covers one product. */
function excessProfile(avgExcess, product) {
  return {
    avgExcess,
    products: avgExcess > 0
      ? [
          {
            productId: product.product_id,
            name: product.product_name,
            excessUnits: Math.round(avgExcess),
          },
        ]
      : [],
  };
}

function toSimulationResult(result, config) {
  const ai = result.xgb_metrics || {};
  const base = result.baseline_metrics || {};
  const comparison = result.cost_comparison || {};
  const labels = [POLICY_LABELS.xgboost, POLICY_LABELS.baseline];
  const trajectory = result.daily_trajectory || [];
  const stockout = stockoutProfile(trajectory, ai, result);
  const avgExcess = meanExcessAbove(trajectory, 'xgb_closing_stock', result.safety_stock);
  const avgExcessBaseline = meanExcessAbove(trajectory, 'baseline_closing_stock', result.safety_stock);
  const excess = excessProfile(avgExcess, result);

  return {
    config: {
      ...config,
      productCount: 1,
      productId: result.product_id,
      productName: result.product_name,
      start: result.start_date,
      end: result.end_date,
      durationDays: result.duration_days,
      leadTimeDays: result.lead_time_days,
      safetyStock: result.safety_stock,
      forecastErrorStd: result.forecast_error_std,
      startingStock: result.starting_stock,
    },
    selectedPolicy: POLICY_LABELS[comparison.recommended_strategy] || result.cost_comparison?.recommended_strategy,
    recommendedStrategy: comparison.recommended_strategy,
    expectedSavings: comparison.expected_savings,
    kpis: toKpis(ai, base, avgExcess),
    stockout: {
      events: stockout.events,
      productsAffected: stockout.productsAffected,
      totalLostUnits: ai.lost_sales_units ?? 0,
      avgDuration: stockout.avgDuration,
    },
    excess: {
      products: excess.products,
      avgExcess: Math.round(excess.avgExcess),
      holdingCost: ai.holding_cost ?? 0,
      totalExcess: Math.round(ai.maximum_inventory ?? 0),
    },
    chart: trajectory.map((point) => ({
      date: point.date,
      stock: point.xgb_closing_stock,
      baselineStock: point.baseline_closing_stock,
    })),
    comparison: {
      metrics: ['Service Level', 'Stockouts', 'Excess Inventory', 'Inventory Cost'],
      rows: [
        { metric: 'Service Level', format: 'percent', values: [ai.service_level ?? 0, base.service_level ?? 0] },
        { metric: 'Stockouts', format: 'number', values: [ai.lost_sales_units ?? 0, base.lost_sales_units ?? 0] },
        { metric: 'Excess Inventory', format: 'number', values: [Math.round(avgExcess), Math.round(avgExcessBaseline)] },
        { metric: 'Inventory Cost', format: 'currency', values: [ai.total_inventory_cost ?? 0, base.total_inventory_cost ?? 0] },
      ],
      labels,
    },
    generatedAt: new Date().toISOString(),
  };
}

function toKpis(ai, base, avgExcess) {
  return {
    serviceLevel: ai.service_level ?? 0,
    stockoutEvents: ai.stockout_days ?? 0,
    stockoutUnits: ai.lost_sales_units ?? 0,
    // The same excess measure the panel below it reports, so the headline and
    // the breakdown cannot disagree about what "excess" meant.
    excessInventory: Math.round(avgExcess),
    inventoryCost: ai.total_inventory_cost ?? 0,
    totalOrders: ai.number_of_orders ?? 0,
    holdingCost: ai.holding_cost ?? 0,
    orderingCost: ai.ordering_cost ?? 0,
    stockoutCost: ai.stockout_cost ?? 0,
    stockoutsAvoidedDemandUnits: Math.max(
      0,
      (base.lost_sales_units ?? 0) - (ai.lost_sales_units ?? 0),
    ),
  };
}
