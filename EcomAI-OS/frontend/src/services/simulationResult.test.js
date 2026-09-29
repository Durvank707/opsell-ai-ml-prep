// The response shaper: what the results panel is allowed to see.
//
// The server answers a lot of questions at once, and the old panel read them in
// a way that made two of them look like one verdict. `cost_comparison` carries a
// `recommended_strategy`, and the results panel turned that into a highlighted
// "best" column — a claim the backtest does not support, because a lower total
// cost over a fixed window is a trade-off, not a proof. The shaper exists partly
// to make that impossible: the comparison is split into policies and methods,
// and nothing else survives into the view model.

import { describe, expect, it } from 'vitest';
import {
  effectivePolicySummary,
  meanExcessAbove,
  summarise,
  toSimulationResult,
} from './simulationResult';
import { SIMULATION_DISCLAIMER, SIMULATION_SCOPE } from './simulationPolicy';

const METRIC_KEYS = {
  stockout_days: 2,
  lost_sales_units: 14,
  service_level: 96.4,
  average_inventory: 41.5,
  maximum_inventory: 88,
  number_of_orders: 6,
  total_units_ordered: 310,
  holding_cost: 1200.5,
  ordering_cost: 3000,
  stockout_cost: 14000,
  total_inventory_cost: 18200.5,
};

function metrics(overrides = {}) {
  return { ...METRIC_KEYS, ...overrides };
}

/** A backtest response shaped exactly as `TenantWorkspace.backtest` returns it. */
function payload(overrides = {}) {
  return {
    product_id: 'P001',
    product_name: 'Wireless Headphones',
    start_date: '2025-01-01',
    end_date: '2025-03-31',
    duration_days: 90,
    unit_cost: 1000,
    starting_stock: 60,
    safety_stock: 20,
    forecast_error_std: 4.2,
    lead_time_days: 7,
    scope: SIMULATION_SCOPE,
    policy: {
      key: 'current',
      label: 'Current Policy',
      description: 'Uses the standard EcomAI-OS replenishment rules.',
      safety_stock: 20,
      coverage_days: 7,
      average_reorder_point: 74.5,
      average_order_up_to: 74.5,
      parameters: {},
    },
    policy_comparison: [
      {
        key: 'current',
        label: 'Current Policy',
        description: 'Uses the standard EcomAI-OS replenishment rules.',
        safety_stock: 20,
        coverage_days: 7,
        average_reorder_point: 74.5,
        average_order_up_to: 74.5,
        stockout_days: 2,
        stockout_units: 14,
        service_level: 96.4,
        average_inventory: 41.5,
        excess_inventory: 12.25,
        number_of_orders: 6,
        total_units_ordered: 310,
        total_inventory_cost: 18200.5,
      },
      {
        key: 'conservative',
        label: 'Conservative',
        description: 'Keep more safety inventory.',
        safety_stock: 30,
        coverage_days: 7,
        average_reorder_point: 84.5,
        average_order_up_to: 84.5,
        stockout_days: 0,
        stockout_units: 0,
        service_level: 100,
        average_inventory: 61.2,
        excess_inventory: 25.4,
        number_of_orders: 7,
        total_units_ordered: 340,
        total_inventory_cost: 24500,
      },
      {
        key: 'aggressive',
        label: 'Aggressive',
        description: 'Keep leaner inventory.',
        safety_stock: 10,
        coverage_days: 7,
        average_reorder_point: 64.5,
        average_order_up_to: 64.5,
        stockout_days: 5,
        stockout_units: 40,
        service_level: 90.1,
        average_inventory: 28.4,
        excess_inventory: 6.1,
        number_of_orders: 9,
        total_units_ordered: 360,
        total_inventory_cost: 22100,
      },
    ],
    xgb_metrics: metrics(),
    baseline_metrics: metrics({ stockout_days: 4, service_level: 92.0, average_inventory: 33.0 }),
    cost_comparison: {
      recommended_strategy: 'xgboost',
      expected_savings: 3899.5,
      cost_difference: -3899.5,
    },
    daily_trajectory: [
      {
        date: '2025-01-01',
        xgb_closing_stock: 50,
        baseline_closing_stock: 44,
        xgb_order_qty: 0,
        baseline_order_qty: 0,
        xgb_stockout_units: 0,
        baseline_stockout_units: 0,
        xgb_open_order_units: 0,
        baseline_open_order_units: 0,
        xgb_reorder_point: 74.5,
        baseline_reorder_point: 74.5,
      },
      {
        date: '2025-01-02',
        xgb_closing_stock: 12,
        baseline_closing_stock: 10,
        xgb_order_qty: 62,
        baseline_order_qty: 66,
        xgb_stockout_units: 3,
        baseline_stockout_units: 5,
        xgb_open_order_units: 62,
        baseline_open_order_units: 66,
        xgb_reorder_point: 74.5,
        baseline_reorder_point: 74.5,
      },
    ],
    ...overrides,
  };
}

describe('excess inventory', () => {
  it('measures stock above the safety buffer, not total stock', () => {
    // 30 units against a 20-unit buffer is 10 units of excess, and 10 units
    // against the same buffer is none.
    const trajectory = [{ s: 30 }, { s: 10 }];
    expect(meanExcessAbove(trajectory, 's', 20)).toBe(5);
  });

  it('is zero for an empty trajectory rather than NaN', () => {
    expect(meanExcessAbove([], 's', 20)).toBe(0);
  });

  it('treats a missing or negative buffer as no buffer', () => {
    const trajectory = [{ s: 10 }];
    expect(meanExcessAbove(trajectory, 's', undefined)).toBe(10);
    expect(meanExcessAbove(trajectory, 's', -5)).toBe(10);
  });

  it('reads the two forecast methods off the same series', () => {
    const result = toSimulationResult(payload());
    // The first day holds 50 against a 20 buffer (30 excess) and the second
    // holds 12 (none), so 15 units of excess on average.
    expect(result.kpis.excessInventory).toBe(15);
    // The baseline held 44 then 10 over the same days: 24 units of excess on one
    // day and none on the other, so 12 on average.
    expect(result.forecastComparison[1].excessInventory).toBe(12);
  });
});

describe('the headline summary', () => {
  it('says "no stockout days" in the singular case, rather than "0 days"', () => {
    expect(summarise({ stockoutDays: 0, averageInventory: 12.4 })).toContain('no stockout days');
  });

  it('agrees with itself about plurals', () => {
    expect(summarise({ stockoutDays: 1, averageInventory: 0 })).toContain('1 stockout day');
    expect(summarise({ stockoutDays: 3, averageInventory: 0 })).toContain('3 stockout days');
  });

  it('rounds inventory to whole units, which is what a reader compares', () => {
    expect(summarise({ stockoutDays: 1, averageInventory: 41.5 })).toContain('average of 42 units');
  });

  it('says nothing it was not told', () => {
    const text = summarise({ stockoutDays: 2, averageInventory: 41.5 });
    expect(text).not.toMatch(/\b(best|winner|recommend)/i);
    expect(text).not.toMatch(/service level/i);
    expect(text).not.toMatch(/cost/i);
  });

  it('is built only from the numbers the server reported', () => {
    const result = toSimulationResult(payload());
    expect(result.summary).toBe(
      summarise({ stockoutDays: 2, averageInventory: 41.5 }),
    );
  });
});

describe('the two comparisons', () => {
  it('keeps the policy comparison and the forecast comparison apart', () => {
    const result = toSimulationResult(payload());
    // Three policies against each other...
    expect(result.policyComparison.map((row) => row.key)).toEqual([
      'current',
      'conservative',
      'aggressive',
    ]);
    // ...and two forecasting methods against each other, in a different list.
    expect(result.forecastComparison.map((row) => row.key)).toEqual(['xgboost', 'baseline']);
    // Neither list is a copy of the other, so a panel cannot confuse them.
    expect(result.forecastComparison).not.toHaveLength(result.policyComparison.length);
  });

  it('carries each policy\'s effective buffer into the table', () => {
    const result = toSimulationResult(payload());
    const conservative = result.policyComparison.find((row) => row.key === 'conservative');
    expect(conservative.safetyStock).toBe(30);
    expect(conservative.coverageDays).toBe(7);
  });

  it('describes each forecast method, so the row is not a bare name', () => {
    const result = toSimulationResult(payload());
    for (const row of result.forecastComparison) {
      expect(row.description.length).toBeGreaterThan(10);
    }
  });
});

describe('not declaring a winner', () => {
  it('drops the server\'s recommended strategy rather than passing it through', () => {
    const result = toSimulationResult(payload());
    expect(result.recommendedStrategy).toBeUndefined();
    expect(result.selectedPolicy).toBeUndefined();
    expect(result.expectedSavings).toBeUndefined();
    expect(result.winner).toBeUndefined();
  });

  it('leaves no trace of a verdict anywhere in the view model', () => {
    const serialised = JSON.stringify(toSimulationResult(payload())).toLowerCase();
    for (const word of ['recommended', 'recommendedstrategy', 'best', 'winner']) {
      expect(serialised).not.toContain(word);
    }
  });

  it('still scores the method rows from the real metrics', () => {
    // Refusing to pick is not the same as refusing to report: the numbers that
    // let a user decide are all still there.
    const result = toSimulationResult(payload());
    const [xgb, baseline] = result.forecastComparison;
    expect(xgb.stockoutDays).toBe(2);
    expect(baseline.stockoutDays).toBe(4);
    expect(xgb.serviceLevel).toBe(96.4);
    expect(baseline.serviceLevel).toBe(92);
    expect(xgb.inventoryCost).toBe(18200.5);
  });
});

describe('the effective policy', () => {
  it('reports the levels the run actually used', () => {
    const result = toSimulationResult(payload());
    expect(result.policy.key).toBe('current');
    expect(result.policy.safetyStock).toBe(20);
    expect(result.policy.averageReorderPoint).toBe(74.5);
    expect(result.policyHint).toContain('Safety stock 20 units');
    expect(result.policyHint).toContain('reordering at about 75 units');
  });

  it('lists the custom parameters that were actually supplied', () => {
    const result = toSimulationResult(
      payload({
        policy: {
          key: 'custom',
          label: 'Custom',
          description: 'Set your own policy parameters.',
          safety_stock: 45,
          coverage_days: 14,
          average_reorder_point: 140,
          average_order_up_to: 140,
          parameters: { safety_stock: 45, coverage_days: 14 },
        },
      }),
    );
    expect(result.policy.parameters.map((entry) => entry.name)).toEqual([
      'safety_stock',
      'coverage_days',
    ]);
    expect(result.policyHint).toContain('Safety stock 45 units');
    expect(result.policyHint).toContain('covering 14 days of demand');
  });

  it('names nothing for a preset, because a preset has no parameters', () => {
    expect(toSimulationResult(payload()).policy.parameters).toEqual([]);
  });

  it('summarises a policy with no reorder point without printing a blank', () => {
    const text = effectivePolicySummary({
      safetyStock: 0,
      coverageDays: null,
      averageReorderPoint: 0,
    });
    expect(text).toBe('Safety stock 0 units.');
  });
});

describe('stockout events', () => {
  it('groups consecutive lost-unit days into separate episodes', () => {
    const result = toSimulationResult(
      payload({
        daily_trajectory: [
          { date: 'd1', xgb_stockout_units: 0 },
          { date: 'd2', xgb_stockout_units: 4 },
          { date: 'd3', xgb_stockout_units: 2 },
          { date: 'd4', xgb_stockout_units: 0 },
          { date: 'd5', xgb_stockout_units: 1 },
        ],
        xgb_metrics: metrics({ stockout_days: 3 }),
      }),
    );
    // Three lost-unit days, but only two separate stockouts.
    expect(result.stockout.days).toBe(3);
    expect(result.stockout.events).toBe(2);
    expect(result.stockout.averageDuration).toBe(1.5);
  });

  it('falls back to the server\'s own day count when there is no series to read', () => {
    const result = toSimulationResult(
      payload({ daily_trajectory: [], xgb_metrics: metrics({ stockout_days: 4 }) }),
    );
    expect(result.stockout.days).toBe(4);
    expect(result.stockout.events).toBe(4);
  });
});

describe('what the panel gets', () => {
  it('always carries the scope and the honesty statement', () => {
    const result = toSimulationResult(payload());
    expect(result.scope).toBe(SIMULATION_SCOPE);
    expect(result.disclaimer).toBe(SIMULATION_DISCLAIMER);
  });

  it('identifies the one product it replayed', () => {
    const result = toSimulationResult(payload());
    expect(result.productId).toBe('P001');
    expect(result.productName).toBe('Wireless Headphones');
    expect(result.durationDays).toBe(90);
  });

  it('reads the mode from the caller, so a demo run is never passed off as real', () => {
    expect(toSimulationResult(payload(), { mode: 'mock' }).mode).toBe('mock');
    expect(toSimulationResult(payload(), { mode: 'api' }).mode).toBe('api');
  });

  it('plots the selected policy\'s own stock line, with in-transit stock beside it', () => {
    const result = toSimulationResult(payload());
    expect(result.chart).toEqual([
      { date: '2025-01-01', stock: 50, baselineStock: 44, inTransit: 0, reorderPoint: 74.5 },
      { date: '2025-01-02', stock: 12, baselineStock: 10, inTransit: 62, reorderPoint: 74.5 },
    ]);
  });

  it('survives a response with no trajectory and no comparison rows', () => {
    // A thin response should render an empty table, not a thrown render.
    const result = toSimulationResult({ product_id: 'P9', product_name: 'Widget' });
    expect(result.chart).toEqual([]);
    expect(result.policyComparison).toEqual([]);
    expect(result.forecastComparison).toHaveLength(2);
    expect(result.kpis.averageInventory).toBe(0);
  });
});
