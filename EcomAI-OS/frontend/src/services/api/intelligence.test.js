// What the simulation page actually asks the server to run.
//
// The policy used to be a browser-only concept: the form offered "Conservative"
// and "Aggressive", but the request carried neither, so api mode always replayed
// the production rule while the page showed the user a different policy's name.
// The policy is now part of the request, and these tests pin what is sent —
// including the two things that must *not* be sent, because the server refuses
// them: custom parameters on a fixed preset, and a scope wider than one product.

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

/** The smallest response the shaper accepts without inventing anything. */
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
    policy: {
      key: 'current',
      label: 'Current Policy',
      safety_stock: 20,
      coverage_days: 7,
      average_reorder_point: 74.5,
      average_order_up_to: 74.5,
      parameters: {},
    },
    policy_comparison: [],
    xgb_metrics: { stockout_days: 2, service_level: 96.4, average_inventory: 41.5 },
    baseline_metrics: { stockout_days: 4, service_level: 92, average_inventory: 33 },
    cost_comparison: { recommended_strategy: 'xgboost', expected_savings: 100 },
    daily_trajectory: [],
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    productIds: ['P001'],
    policy: 'current',
    policyParams: null,
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

describe('the policy in the request', () => {
  it('sends the policy the user chose', async () => {
    for (const policy of ['current', 'conservative', 'aggressive', 'custom']) {
      http.postBacktest.mockClear();
      await runSimulation(USER, config({ policy }));
      expect(body().policy).toBe(policy);
    }
  });

  it('defaults to the current policy rather than sending nothing', async () => {
    await runSimulation(USER, config({ policy: undefined }));
    expect(body().policy).toBe('current');
  });

  it('sends the custom parameters when the custom policy is chosen', async () => {
    await runSimulation(
      USER,
      config({ policy: 'custom', policyParams: { safety_stock: 45, coverage_days: 14 } }),
    );
    expect(body().policy_params).toEqual({ safety_stock: 45, coverage_days: 14 });
  });

  it('sends nothing for a preset, which the server refuses rather than ignores', async () => {
    // A preset given parameters is a 400. Sending null keeps a stale value from
    // a previous custom run out of a fixed-policy request.
    await runSimulation(
      USER,
      config({ policy: 'aggressive', policyParams: { safety_stock: 45 } }),
    );
    expect(body().policy_params).toBeNull();
  });

  it('lets the server reject an unknown policy rather than quietly substituting', async () => {
    // No local allow-list: the server owns the catalogue, and its error names
    // the policies it does support. Guessing here would hide a mismatch.
    http.postBacktest.mockRejectedValueOnce(
      new Error(
        "'wild' is not a supported inventory policy. Choose one of: current, conservative, aggressive, custom.",
      ),
    );
    await expect(runSimulation(USER, config({ policy: 'wild' }))).rejects.toThrow(
      /not a supported inventory policy/i,
    );
    expect(body().policy).toBe('wild');
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
    expect(result.policy.key).toBe('current');
    expect(result.forecastComparison).toHaveLength(2);
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
