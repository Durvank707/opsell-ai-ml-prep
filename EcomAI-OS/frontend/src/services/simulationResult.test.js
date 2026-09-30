// The response shaper: what the results panel is allowed to see.
//
// One run now replays every strategy, so the shaper's job is to hand the panel
// one list of strategies — each with its own metrics and its own day-by-day
// history — and to keep the forecasting evaluation in a separate corner. It
// exists partly to make a verdict impossible: the server still reports a
// `recommended_strategy` for the model comparison, and nothing here lets it
// reach the inventory result, where it would read as advice about a strategy.

import { describe, expect, it } from 'vitest';
import {
  appliedCustomParameters,
  meanExcessAbove,
  summarise,
  toSimulationResult,
} from './simulationResult';
import {
  FORBIDDEN_RESULT_LANGUAGE,
  SIMULATION_DISCLAIMER,
  SIMULATION_SCOPE,
} from './simulationPolicy';

/** A comparison row exactly as `TenantWorkspace.backtest` reports one. */
function row(key, label, overrides = {}) {
  return {
    key,
    label,
    description: `${label} description`,
    safety_stock: 20,
    coverage_days: 7,
    average_reorder_point: 74.5,
    average_order_up_to: 74.5,
    stockout_days: 2,
    stockout_units: 14,
    service_level: 96.4,
    average_inventory: 41.5,
    maximum_inventory: 88,
    excess_inventory: 21.5,
    number_of_orders: 6,
    total_units_ordered: 310,
    holding_cost: 1200.5,
    ordering_cost: 3000,
    stockout_cost: 14000,
    total_inventory_cost: 18200.5,
    ...overrides,
  };
}

/** One strategy's daily history, shaped as the server's `_timeline` returns it. */
function timeline(overrides = {}) {
  return [
    {
      date: '2025-01-01',
      demand: 11,
      arrival_qty: 0,
      units_fulfilled: 11,
      stockout_units: 0,
      closing_stock: 50,
      open_order_units: 0,
      inventory_position: 50,
      order_qty: 40,
      reorder_required: true,
      reorder_point: 74.5,
      target_inventory: 74.5,
      safety_stock: 20,
      ...overrides,
    },
    {
      date: '2025-01-02',
      demand: 60,
      arrival_qty: 40,
      units_fulfilled: 30,
      stockout_units: 30,
      closing_stock: 0,
      open_order_units: 0,
      inventory_position: 0,
      order_qty: 0,
      reorder_required: false,
      reorder_point: 74.5,
      target_inventory: 74.5,
      safety_stock: 20,
      ...overrides,
    },
  ];
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
    policies_evaluated: ['current', 'conservative', 'aggressive'],
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
      row('current', 'Current Policy'),
      row('conservative', 'Conservative', {
        safety_stock: 30,
        stockout_days: 0,
        service_level: 100,
        average_inventory: 61.2,
        number_of_orders: 7,
        total_inventory_cost: 24500,
      }),
      row('aggressive', 'Aggressive', {
        safety_stock: 10,
        stockout_days: 5,
        service_level: 90.1,
        average_inventory: 28.4,
        number_of_orders: 9,
        total_inventory_cost: 22100,
      }),
    ],
    policy_timelines: {
      current: timeline(),
      conservative: timeline({ safety_stock: 30, reorder_point: 84.5 }),
      aggressive: timeline({ safety_stock: 10, reorder_point: 64.5 }),
    },
    xgb_metrics: {
      stockout_days: 2,
      lost_sales_units: 14,
      service_level: 96.4,
      average_inventory: 41.5,
      number_of_orders: 6,
      total_inventory_cost: 18200.5,
    },
    baseline_metrics: {
      stockout_days: 4,
      lost_sales_units: 28,
      service_level: 92,
      average_inventory: 33,
      number_of_orders: 7,
      total_inventory_cost: 22100,
    },
    cost_comparison: {
      recommended_strategy: 'xgboost',
      expected_savings: 3899.5,
      cost_difference: 3899.5,
    },
    ...overrides,
  };
}

describe('what the panel gets', () => {
  it('hands over one list of strategies, in the order the server sent them', () => {
    const result = toSimulationResult(payload());
    expect(result.strategies.map((entry) => entry.key)).toEqual([
      'current',
      'conservative',
      'aggressive',
    ]);
    expect(result.tabKeys).toEqual(['current', 'conservative', 'aggressive']);
  });

  it('gives each strategy its own history, not the primary one twice', () => {
    const result = toSimulationResult(payload());
    const [current, conservative, aggressive] = result.strategies;
    expect(current.chart[0].stock).toBe(50);
    expect(conservative.chart[0].stock).toBe(50);
    // Same stock, different order levels — which is exactly what makes the
    // strategies different, and what a tab has to be able to show.
    expect(current.chart[0].reorderPoint).toBe(74.5);
    expect(conservative.chart[0].reorderPoint).toBe(84.5);
    expect(aggressive.chart[0].reorderPoint).toBe(64.5);
  });

  it('carries the in-transit, order and unmet-demand series the chart draws', () => {
    const result = toSimulationResult(payload());
    const point = result.strategiesByKey.current.chart[1];
    expect(point.lost).toBe(30);
    expect(point.demand).toBe(60);
    expect(point.fulfilled).toBe(30);
    expect(point.arrivalQty).toBe(40);
    expect(point.orderQty).toBe(0);
    expect(point.inTransit).toBe(0);
  });

  it('keeps the days and the window consistent across strategies', () => {
    const result = toSimulationResult(payload());
    const lengths = result.strategies.map((entry) => entry.chart.length);
    expect(new Set(lengths).size).toBe(1);
    expect(result.durationDays).toBe(90);
  });

  it('opens on the primary strategy the server reported', () => {
    const result = toSimulationResult(payload());
    expect(result.initialPolicyKey).toBe('current');
  });

  it('falls back to the first strategy when the primary was not simulated', () => {
    // Defensive: a panel that opened on a key with no data would show an empty
    // graph with no explanation.
    const body = payload({ policy: { ...payload().policy, key: 'aggressive' } });
    body.policies_evaluated = ['current'];
    body.policy_comparison = [row('current', 'Current Policy')];
    body.policy_timelines = { current: timeline() };
    const result = toSimulationResult(body);
    expect(result.initialPolicyKey).toBe('current');
  });

  it('survives a strategy the server compared but gave no timeline for', () => {
    const body = payload({ policy_timelines: { current: timeline() } });
    const result = toSimulationResult(body);
    expect(result.strategies).toHaveLength(3);
    expect(result.strategiesByKey.conservative.chart).toEqual([]);
  });

  it('carries the cost breakdown, so the panel can show what the total is made of', () => {
    const result = toSimulationResult(payload());
    const current = result.strategiesByKey.current;
    expect(current.holdingCost).toBe(1200.5);
    expect(current.orderingCost).toBe(3000);
    expect(current.stockoutCost).toBe(14000);
    expect(current.inventoryCost).toBe(18200.5);
  });

  it('labels a strategy the server described with a key this build has not heard of', () => {
    const result = toSimulationResult(payload());
    expect(result.strategiesByKey.current.label).toBe('Current Policy');
  });

  it('keeps the scope and the disclaimer on the result', () => {
    const result = toSimulationResult(payload());
    expect(result.scope).toBe(SIMULATION_SCOPE);
    expect(result.disclaimer).toBe(SIMULATION_DISCLAIMER);
  });
});

describe('the custom strategy', () => {
  const customPayload = () => {
    const body = payload({
      policies_evaluated: ['current', 'conservative', 'aggressive', 'custom'],
      policy: { ...payload().policy, key: 'custom', parameters: { safety_stock: 200 } },
    });
    body.policy_comparison = [
      ...body.policy_comparison,
      row('custom', 'Custom', { safety_stock: 200, coverage_days: 12 }),
    ];
    body.policy_timelines = {
      ...body.policy_timelines,
      custom: timeline({ safety_stock: 200, reorder_point: 254.5 }),
    };
    return body;
  };

  it('appears only when the server replayed it', () => {
    expect(toSimulationResult(payload()).hasCustom).toBe(false);
    expect(toSimulationResult(customPayload()).hasCustom).toBe(true);
  });

  it('gets its own tab, because it has its own history', () => {
    const result = toSimulationResult(customPayload());
    expect(result.tabKeys).toContain('custom');
    expect(result.strategiesByKey.custom.chart[0].reorderPoint).toBe(254.5);
  });

  it('reports the parameters the run actually applied', () => {
    const applied = appliedCustomParameters(toSimulationResult(customPayload()));
    expect(applied).toEqual([
      expect.objectContaining({ name: 'safety_stock', value: 200 }),
    ]);
    // Coverage was not supplied, so the server's own value is not invented here.
    expect(applied.map((entry) => entry.name)).toEqual(['safety_stock']);
  });

  it('reports no parameters for a run that used none', () => {
    expect(appliedCustomParameters(toSimulationResult(payload()))).toEqual([]);
  });
});

describe('the headline summary', () => {
  it('is comparative, and reports the range the strategies spanned', () => {
    const result = toSimulationResult(payload());
    expect(result.summary).toMatch(/Over the 90 recorded days/);
    expect(result.summary).toMatch(/3 strategies were replayed/);
    expect(result.summary).toMatch(/stockouts ranged from 0 to 5 days/);
    expect(result.summary).toMatch(/average inventory ranged from 28 to 61 units/);
  });

  it('names the product, so the sentence stands on its own', () => {
    expect(toSimulationResult(payload()).summary).toMatch(/Wireless Headphones/);
  });

  it('does not single out a strategy', () => {
    const summary = toSimulationResult(payload()).summary;
    for (const label of ['Current Policy', 'Conservative', 'Aggressive']) {
      expect(summary).not.toContain(label);
    }
  });

  it('reports a single-strategy run without pretending to compare', () => {
    const body = payload({
      policies_evaluated: ['current'],
      policy_comparison: [row('current', 'Current Policy')],
      policy_timelines: { current: timeline() },
    });
    const summary = toSimulationResult(body).summary;
    expect(summary).toMatch(/1 strategy was replayed/);
    expect(summary).toMatch(/2 stockout days/);
  });

  it('says so when no strategy came back at all', () => {
    const body = payload({ policy_comparison: [], policy_timelines: {} });
    expect(toSimulationResult(body).summary).toMatch(/No inventory strategy was replayed/);
  });

  it('handles a run that was built by hand', () => {
    const text = summarise({
      durationDays: 30,
      productName: 'Widget',
      strategies: [
        { stockoutDays: 0, averageInventory: 40, serviceLevel: 100 },
        { stockoutDays: 0, averageInventory: 40, serviceLevel: 100 },
      ],
    });
    expect(text).toMatch(/2 strategies were replayed/);
    expect(text).toMatch(/no stockout days/);
  });
});

describe('not declaring a winner', () => {
  it('keeps the models verdict out of the inventory result', () => {
    const result = toSimulationResult(payload());
    // The server still sends `recommended_strategy`; nothing above carries it.
    expect(result.strategies).not.toHaveProperty('recommendedStrategy');
    expect(JSON.stringify(result.strategies)).not.toMatch(/recommended_strategy/);
  });

  it('buries the model comparison in its own corner, unranked', () => {
    const result = toSimulationResult(payload());
    expect(result.modelDetails.methods.map((method) => method.key)).toEqual([
      'xgboost',
      'baseline',
    ]);
    // No ranking, no per-method excess the server never computed.
    expect(result.modelDetails.methods[0]).not.toHaveProperty('excessInventory');
    expect(JSON.stringify(result.modelDetails)).not.toMatch(/recommended_strategy/);
  });

  it('says model evaluation is not an inventory decision', () => {
    const result = toSimulationResult(payload());
    expect(result.modelDetails.note).toMatch(/does not change your inventory policy/i);
  });

  it('uses no verdict language anywhere in the result', () => {
    const result = toSimulationResult(payload());
    const text = [
      result.summary,
      result.comparisonNote,
      result.tabsNote,
      result.modelDetails.note,
      result.modelDetails.meaning,
      ...result.strategies.map((entry) => `${entry.label} ${entry.description}`),
    ]
      .join(' ')
      .toLowerCase();
    for (const phrase of FORBIDDEN_RESULT_LANGUAGE) {
      expect(text).not.toContain(phrase);
    }
  });
});

describe('stockout events', () => {
  it('groups consecutive unmet-demand days into one episode', () => {
    const result = toSimulationResult(payload());
    // The fixture's second day is the only unmet one, so one episode of one day.
    expect(result.strategiesByKey.current.stockout).toEqual({
      events: 1,
      days: 1,
      avgDuration: 1,
    });
  });

  it('counts an unbroken run as a single episode', () => {
    const body = payload({
      policy_timelines: {
        current: [
          { ...timeline()[0], stockout_units: 5 },
          { ...timeline()[1], stockout_units: 5 },
          { ...timeline()[0], date: '2025-01-03', stockout_units: 0 },
        ],
      },
    });
    const result = toSimulationResult(body);
    expect(result.strategiesByKey.current.stockout.events).toBe(1);
    expect(result.strategiesByKey.current.stockout.days).toBe(2);
  });

  it('prefers the series over the reported total, which may be a stub', () => {
    const body = payload({ policy_timelines: { current: timeline({ stockout_units: 0 }) } });
    body.policy_comparison[0].stockout_days = 4;
    const result = toSimulationResult(body);
    expect(result.strategiesByKey.current.stockout.days).toBe(4);
  });
});

describe('excess inventory', () => {
  it('reads the buffer off the strategy, per point', () => {
    // Stock above the strategy's own buffer, averaged: (50-20) and (0-20 → 0).
    expect(meanExcessAbove(timeline(), 20)).toBe(15);
  });

  it('is zero for an empty history rather than NaN', () => {
    expect(meanExcessAbove([], 20)).toBe(0);
    expect(meanExcessAbove(null, 20)).toBe(0);
  });

  it('takes the server value, so a run that holds more is not called waste', () => {
    const result = toSimulationResult(payload());
    expect(result.strategiesByKey.conservative.excessInventory).toBe(21.5);
  });
});
