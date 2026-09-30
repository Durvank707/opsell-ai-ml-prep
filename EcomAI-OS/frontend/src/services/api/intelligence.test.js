// What the simulation page actually asks the server to run.
//
// One request now covers every strategy, so these tests pin the list the page
// sends and the two things that must *not* travel with it: custom parameters
// without the custom arm, and a scope wider than one product. Both are refused
// server-side, and the point of sending them correctly is that the page never
// discovers the rule by hitting a 422.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({
  fetchRecommendations: vi.fn(),
  postBacktest: vi.fn(),
}));

vi.mock('./http', () => http);
// The data mode is a build-time setting and `requireApiSession` only asserts an
// access token exists; neither is what these tests are about.
vi.mock('./mode', () => ({ requireApiSession: () => {} }));

const { runSimulation } = await import('./intelligence');

const USER = { id: 'tenant-a' };

function comparisonRow(key, overrides = {}) {
  return {
    key,
    label: key,
    description: `${key} description`,
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
    holding_cost: 1200,
    ordering_cost: 3000,
    stockout_cost: 14000,
    total_inventory_cost: 18200,
    ...overrides,
  };
}

function timeline(key) {
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
    },
  ].map((point) => ({ ...point, reorder_point: key === 'aggressive' ? 64.5 : 74.5 }));
}

/** A response shaped exactly as `TenantWorkspace.backtest` returns one. */
function response(overrides = {}) {
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
    scope: 'single_product',
    policies_evaluated: ['current', 'conservative', 'aggressive'],
    policy: {
      key: 'current',
      label: 'Current Policy',
      safety_stock: 20,
      coverage_days: 7,
      average_reorder_point: 74.5,
      average_order_up_to: 74.5,
      parameters: {},
    },
    policy_comparison: [
      comparisonRow('current'),
      comparisonRow('conservative'),
      comparisonRow('aggressive'),
    ],
    policy_timelines: {
      current: timeline('current'),
      conservative: timeline('conservative'),
      aggressive: timeline('aggressive'),
    },
    xgb_metrics: { stockout_days: 2, service_level: 96.4, average_inventory: 41.5 },
    baseline_metrics: { stockout_days: 4, service_level: 92, average_inventory: 33 },
    cost_comparison: { recommended_strategy: 'xgboost', expected_savings: 100 },
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    productIds: ['P001'],
    customEnabled: false,
    customParams: null,
    startDate: '',
    endDate: '',
    periodIsDefault: true,
    orderingCost: 500,
    stockoutCost: 1000,
    ...overrides,
  };
}

const body = () => http.postBacktest.mock.calls[0][1];

beforeEach(() => {
  Object.values(http).forEach((fn) => fn.mockReset());
  http.postBacktest.mockResolvedValue(response());
});

describe('scope', () => {
  it('refuses a run with nothing chosen, before calling the server', async () => {
    await expect(runSimulation(USER, config({ productIds: [] }))).rejects.toThrow(
      /choose a product to simulate/i,
    );
    expect(http.postBacktest).not.toHaveBeenCalled();
  });

  it('refuses more than one product, because the engine has no portfolio mode', async () => {
    await expect(
      runSimulation(USER, config({ productIds: ['P001', 'P002'] })),
    ).rejects.toThrow(/one product at a time/i);
    expect(http.postBacktest).not.toHaveBeenCalled();
  });

  it('sends exactly the one product it was given', async () => {
    await runSimulation(USER, config({ productIds: ['P042'] }));
    expect(body().product_id).toBe('P042');
  });
});

describe('the strategies in the request', () => {
  it('asks for every preset, in one request', async () => {
    // The user chooses no strategy, so the page must not choose one for them:
    // the whole comparison has to come back from a single run.
    await runSimulation(USER, config());
    expect(body().policies).toEqual(['current', 'conservative', 'aggressive']);
    expect(http.postBacktest).toHaveBeenCalledTimes(1);
  });

  it('sends no preset selection of its own, because the user made none', async () => {
    await runSimulation(USER, config());
    expect(body().policy).toBe('current');
  });

  it('adds the custom arm only when the experiment is enabled', async () => {
    await runSimulation(USER, config({ customEnabled: true }));
    expect(body().policies).toEqual(['current', 'conservative', 'aggressive', 'custom']);
  });

  it('sends the custom parameters, naming the custom arm as the primary', async () => {
    await runSimulation(
      USER,
      config({ customEnabled: true, customParams: { safety_stock: 45, coverage_days: 14 } }),
    );
    expect(body().policy_params).toEqual({ safety_stock: 45, coverage_days: 14 });
    // The primary has to be the custom arm, or the server's top-level detail
    // metrics would describe a strategy the user did not type numbers for.
    expect(body().policy).toBe('custom');
  });

  it('sends no custom parameters when the experiment is off', async () => {
    // A preset-only run carrying parameters is a 422. Sending null keeps a value
    // typed into a closed panel out of the request.
    await runSimulation(
      USER,
      config({ customEnabled: false, customParams: { safety_stock: 45 } }),
    );
    expect(body().policy_params).toBeNull();
  });

  it('can add the custom arm with no parameters, using the server defaults', async () => {
    await runSimulation(USER, config({ customEnabled: true, customParams: null }));
    expect(body().policy_params).toBeNull();
    expect(body().policies).toContain('custom');
  });

  it('lets the server reject an unknown policy rather than quietly substituting', async () => {
    // No local allow-list: the server owns the catalogue, and its error names
    // the strategies it does support. Guessing here would hide a mismatch.
    http.postBacktest.mockRejectedValueOnce(
      new Error(
        "'wild' is not a supported inventory policy. Choose one of: current, conservative, aggressive, custom.",
      ),
    );
    await expect(runSimulation(USER, config())).rejects.toThrow(
      /not a supported inventory policy/i,
    );
  });
});

describe('the period in the request', () => {
  it('leaves an untouched period to the server, which owns the window', async () => {
    await runSimulation(USER, config({ periodIsDefault: true, startDate: '', endDate: '' }));
    expect(body().start_date).toBeNull();
    expect(body().end_date).toBeNull();
  });

  it('sends a period the user actually chose', async () => {
    await runSimulation(
      USER,
      config({ periodIsDefault: false, startDate: '2025-02-01', endDate: '2025-03-01' }),
    );
    expect(body().start_date).toBe('2025-02-01');
    expect(body().end_date).toBe('2025-03-01');
  });
});

describe('the cost assumptions in the request', () => {
  it('sends what the user entered', async () => {
    await runSimulation(USER, config({ orderingCost: 750, stockoutCost: 2500 }));
    expect(body().ordering_cost_per_order).toBe(750);
    expect(body().stockout_cost_per_unit).toBe(2500);
  });

  it('falls back to the documented defaults for a blank or zero field', async () => {
    await runSimulation(USER, config({ orderingCost: '', stockoutCost: null }));
    expect(body().ordering_cost_per_order).toBe(500);
    expect(body().stockout_cost_per_unit).toBe(1000);
  });
});

describe('what comes back', () => {
  it('is shaped for the panel rather than passed through raw', async () => {
    const result = await runSimulation(USER, config());
    expect(result.mode).toBe('api');
    expect(result.productId).toBe('P001');
    expect(result.strategies.map((entry) => entry.key)).toEqual([
      'current',
      'conservative',
      'aggressive',
    ]);
    expect(result.tabKeys).toEqual(['current', 'conservative', 'aggressive']);
  });

  it('hands back a timeline per strategy, so the tabs need no second request', async () => {
    const result = await runSimulation(USER, config());
    expect(Object.keys(result.strategiesByKey)).toEqual([
      'current',
      'conservative',
      'aggressive',
    ]);
    expect(result.strategiesByKey.aggressive.chart[0].reorderPoint).toBe(64.5);
  });

  it('keeps the model evaluation out of the inventory result', async () => {
    const result = await runSimulation(USER, config());
    expect(result.modelDetails.methods).toHaveLength(2);
    expect(JSON.stringify(result.strategies)).not.toMatch(/recommended_strategy/);
  });

  it('carries no winner, even though the response names one', async () => {
    const result = await runSimulation(USER, config());
    // The server still reports `recommended_strategy` for the existing API
    // contract, but a lower total cost over a fixed window is a trade-off
    // rather than a proof, so it must not reach the panel.
    expect(result.recommendedStrategy).toBeUndefined();
    expect(result.selectedPolicy).toBeUndefined();
    expect(JSON.stringify(result).toLowerCase()).not.toMatch(/recommended|\bbest\b|winner/);
  });
});
