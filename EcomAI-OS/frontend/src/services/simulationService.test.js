// The browser-only demo engine, and the replenishment rule it replays.
//
// Mock mode is what a tenant sees with no backend, and it used to be a
// different formula wearing the same policy names: it sized the order from the
// whole 30-day forecast instead of the live replenishment rule (lead-time
// demand + safety stock, reorder point, order up to that point). These tests pin
// the corrected rule, and pin that a policy choice actually changes the outcome —
// a policy that does not change anything is a label, not a policy.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store's simulated latency is 1.4s per simulation; these tests are about
// the rule, not the wait, and every other part of the store stays real.
vi.mock('./mock/db', async (importOriginal) => ({
  ...(await importOriginal()),
  latency: async () => {},
}));

const { getDB } = await import('./mock/db');
const { runSimulation, resolvePolicyLevels, validateCustomParams } = await import('./simulationService');
const { INVENTORY_POLICIES, POLICY_LOOKUP, SIMULATION_SCOPE } = await import('./simulationPolicy');

const USER = { id: 'sim-user', email: 'sim@example.com' };
const PRODUCT = {
  id: 'P001',
  sku: 'P001',
  name: 'Wireless Headphones',
  category: 'Electronics',
  unitCost: 1000,
  sellingPrice: 1999,
  currentStock: 60,
  leadTimeDays: 7,
  dailyAvg: 10,
  sigma: 3,
  safetyStock: 20,
};

/** 120 recorded days ending 2025-03-31, with a clear weekly rhythm. */
function series() {
  const rows = [];
  const start = new Date('2024-12-03T00:00:00Z');
  for (let i = 0; i < 120; i += 1) {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + i);
    rows.push({ date: day.toISOString().slice(0, 10), units: 10 + (i % 7 === 6 ? 12 : 0) });
  }
  return rows;
}

function seed(product = PRODUCT, rows = series()) {
  const db = getDB(USER);
  db.products = [product];
  db.salesByProduct = new Map([[product.id, rows]]);
  db.simulations = [];
  return db;
}

function config(overrides = {}) {
  return {
    productIds: [PRODUCT.id],
    policy: 'current',
    policyParams: null,
    startDate: '2025-01-15',
    endDate: '2025-03-31',
    periodIsDefault: false,
    orderingCost: 500,
    stockoutCost: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  seed();
});

describe('scope', () => {
  it('refuses a run with no product chosen', async () => {
    await expect(runSimulation(USER, config({ productIds: [] }))).rejects.toThrow(
      /choose a product to simulate/i,
    );
  });

  it('refuses more than one product rather than simulating one of them', async () => {
    await expect(
      runSimulation(USER, config({ productIds: ['P001', 'P002'] })),
    ).rejects.toThrow(/one product at a time/i);
  });

  it('says which product it replayed, and that it was a single one', async () => {
    const result = await runSimulation(USER, config());
    expect(result.productId).toBe('P001');
    expect(result.productName).toBe('Wireless Headphones');
    expect(result.scope).toBe(SIMULATION_SCOPE);
  });

  it('refuses a product with no recorded sales, because there is nothing to replay', async () => {
    seed(PRODUCT, []);
    await expect(runSimulation(USER, config())).rejects.toThrow(/no sales history/i);
  });

  it('labels a demo run as a demo run', async () => {
    const result = await runSimulation(USER, config());
    expect(result.mode).toBe('mock');
  });
});

describe('the replenishment rule', () => {
  const levels = (profile, overrides) =>
    resolvePolicyLevels(profile, {
      safetyStock: 20,
      dailyForecast: 10,
      leadTimeDays: 7,
      ...overrides,
    });

  it('builds the reorder point from lead-time demand plus the safety buffer', () => {
    // 10 units a day over a 7-day lead time is 70 units of demand to cover,
    // plus a 20-unit buffer: the order is triggered below 90.
    const resolved = levels(POLICY_LOOKUP.current);
    expect(resolved.coverage).toBe(70);
    expect(resolved.safety).toBe(20);
    expect(resolved.reorderPoint).toBe(90);
  });

  it('tops the order up to the reorder point, never to the 30-day forecast', () => {
    // The defect this replaces: the old simulator ordered the whole 30-day
    // forecast (300 units here), which is not what a reorder point means.
    const resolved = levels(POLICY_LOOKUP.current);
    expect(resolved.orderUpTo).toBe(resolved.reorderPoint);
    expect(resolved.orderUpTo).toBeLessThan(10 * 30);
  });

  it('keeps the order-up-to level equal to the reorder point under every policy', () => {
    for (const profile of INVENTORY_POLICIES) {
      expect(levels(profile).orderUpTo).toBe(levels(profile).reorderPoint);
    }
  });

  it('scales only the safety buffer for the presets, leaving coverage on lead time', () => {
    expect(levels(POLICY_LOOKUP.conservative).safety).toBe(30);
    expect(levels(POLICY_LOOKUP.conservative).coverage).toBe(70);
    expect(levels(POLICY_LOOKUP.aggressive).safety).toBe(10);
    expect(levels(POLICY_LOOKUP.aggressive).coverage).toBe(70);
  });

  it('rounds a scaled buffer up, because safety stock is a count of units', () => {
    const resolved = levels(POLICY_LOOKUP.conservative, { safetyStock: 21 });
    expect(resolved.safety).toBe(32);
  });

  it('uses a custom safety stock and coverage verbatim', () => {
    const resolved = levels(POLICY_LOOKUP.custom, {
      custom: { safety_stock: 45, coverage_days: 14 },
    });
    expect(resolved.safety).toBe(45);
    expect(resolved.coverage).toBe(140);
    expect(resolved.reorderPoint).toBe(185);
  });

  it('falls back to the current policy for a field the custom policy omits', () => {
    // Custom with only a buffer is "current, but hold 45 units" — not a guess at
    // what the missing value should have been.
    const onlySafety = levels(POLICY_LOOKUP.custom, { custom: { safety_stock: 45 } });
    expect(onlySafety.safety).toBe(45);
    expect(onlySafety.coverage).toBe(70);
    expect(onlySafety.coverageDays).toBe(7);

    const onlyCoverage = levels(POLICY_LOOKUP.custom, { custom: { coverage_days: 21 } });
    expect(onlyCoverage.safety).toBe(20);
    expect(onlyCoverage.coverage).toBe(210);
  });

  it('honours a zero buffer, which is a real answer', () => {
    const resolved = levels(POLICY_LOOKUP.custom, { custom: { safety_stock: 0 } });
    expect(resolved.safety).toBe(0);
    expect(resolved.reorderPoint).toBe(70);
  });

  it('treats a missing or negative configured buffer as no buffer', () => {
    expect(levels(POLICY_LOOKUP.current, { safetyStock: -8 }).safety).toBe(0);
    expect(levels(POLICY_LOOKUP.current, { safetyStock: undefined }).safety).toBe(0);
  });
});

describe('custom parameters are checked the way the server checks them', () => {
  it('accepts nothing at all', () => {
    expect(validateCustomParams(POLICY_LOOKUP.custom, {})).toBeNull();
    expect(validateCustomParams(POLICY_LOOKUP.custom, null)).toBeNull();
  });

  it('refuses parameters on a fixed preset instead of ignoring them', () => {
    expect(validateCustomParams(POLICY_LOOKUP.current, { safety_stock: 5 })).toMatch(
      /fixed policy and takes no custom parameters/i,
    );
  });

  it('refuses a parameter the server does not apply', () => {
    expect(
      validateCustomParams(POLICY_LOOKUP.custom, { min_stock: 10 }),
    ).toMatch(/accepts only safety_stock and coverage_days/i);
  });

  it('refuses a value that is not a number', () => {
    expect(validateCustomParams(POLICY_LOOKUP.custom, { safety_stock: 'lots' })).toMatch(
      /must be a number/i,
    );
  });

  it('refuses a negative buffer but accepts zero', () => {
    expect(validateCustomParams(POLICY_LOOKUP.custom, { safety_stock: -1 })).toMatch(
      /zero or more/i,
    );
    expect(validateCustomParams(POLICY_LOOKUP.custom, { safety_stock: 0 })).toBeNull();
  });

  it('refuses a zero-day order, which would never arrive', () => {
    expect(validateCustomParams(POLICY_LOOKUP.custom, { coverage_days: 0 })).toMatch(
      /greater than zero/i,
    );
  });

  it('surfaces the refusal to the caller instead of running a different policy', async () => {
    await expect(
      runSimulation(USER, config({ policy: 'aggressive', policyParams: { safety_stock: 5 } })),
    ).rejects.toThrow(/fixed policy/i);
  });
});

describe('a policy actually changes the outcome', () => {
  const run = (policy) => runSimulation(USER, config({ policy }));

  it('holds more stock under a conservative policy and less under an aggressive one', async () => {
    const [aggressive, current, conservative] = await Promise.all([
      run('aggressive'),
      run('current'),
      run('conservative'),
    ]);
    expect(aggressive.kpis.averageInventory).toBeLessThan(current.kpis.averageInventory);
    expect(current.kpis.averageInventory).toBeLessThan(conservative.kpis.averageInventory);
  });

  it('trades stockouts the other way, which is the whole point of the comparison', async () => {
    const [aggressive, conservative] = await Promise.all([run('aggressive'), run('conservative')]);
    expect(conservative.kpis.stockoutDays).toBeLessThanOrEqual(aggressive.kpis.stockoutDays);
    expect(conservative.kpis.serviceLevel).toBeGreaterThanOrEqual(aggressive.kpis.serviceLevel);
  });

  it('reports the buffer each policy actually used', async () => {
    const result = await run('conservative');
    expect(result.policy.safetyStock).toBe(30);
    expect(result.policyComparison.find((row) => row.key === 'conservative').safetyStock).toBe(30);
    expect(result.policyComparison.find((row) => row.key === 'aggressive').safetyStock).toBe(10);
  });

  it('compares only the three fixed presets, in the order the table lists them', async () => {
    const result = await run('custom');
    expect(result.policyComparison.map((row) => row.key)).toEqual([
      'current',
      'conservative',
      'aggressive',
    ]);
  });

  it('orders up to the reorder point, not to a month of demand', async () => {
    const result = await run('current');
    // 7 days of demand at ~10 units plus a 20-unit buffer is about 90 units.
    // The 30-day forecast is about 300, and the old engine ordered that.
    expect(result.policy.averageOrderUpTo).toBeCloseTo(result.policy.averageReorderPoint, 5);
    expect(result.policy.averageOrderUpTo).toBeLessThan(200);
  });

  it('carries a custom buffer all the way into the reported policy', async () => {
    const result = await runSimulation(
      USER,
      config({ policy: 'custom', policyParams: { safety_stock: 60 } }),
    );
    expect(result.policy.key).toBe('custom');
    expect(result.policy.safetyStock).toBe(60);
    expect(result.policy.parameters).toMatchObject([{ name: 'safety_stock', value: 60 }]);
    // Still an order-up-to at the reorder point, three times over.
    expect(result.policy.averageOrderUpTo).toBeCloseTo(result.policy.averageReorderPoint, 5);
  });
});

describe('the forecast comparison', () => {
  it('scores both methods under the policy that was chosen', async () => {
    const result = await runSimulation(USER, config({ policy: 'conservative' }));
    expect(result.forecastComparison.map((row) => row.key)).toEqual(['xgboost', 'baseline']);
    // The conservative 30-unit buffer is in force for both arms, so the two
    // rows are comparable rather than two different policies measured together.
    expect(result.policy.safetyStock).toBe(30);
    for (const row of result.forecastComparison) {
      expect(row.stockoutDays).toBeGreaterThanOrEqual(0);
      expect(row.serviceLevel).toBeGreaterThanOrEqual(0);
    }
  });

  it('declares no winner', async () => {
    const result = await runSimulation(USER, config());
    expect(JSON.stringify(result).toLowerCase()).not.toMatch(/recommended|winner|\bbest\b/);
  });
});

describe('reproducibility', () => {
  it('returns the same result for the same input', async () => {
    const [first, second] = await Promise.all([
      runSimulation(USER, config()),
      runSimulation(USER, config()),
    ]);
    expect(second.kpis).toEqual(first.kpis);
    expect(second.policyComparison).toEqual(first.policyComparison);
    expect(second.chart).toEqual(first.chart);
  });

  it('replays the window it was given, day by day', async () => {
    const result = await runSimulation(USER, config());
    expect(result.start).toBe('2025-01-15');
    expect(result.end).toBe('2025-03-31');
    expect(result.durationDays).toBe(76);
    expect(result.chart).toHaveLength(76);
  });

  it('refuses a window that ends before it starts', async () => {
    await expect(
      runSimulation(USER, config({ startDate: '2025-03-31', endDate: '2025-01-15' })),
    ).rejects.toThrow(/must start before it ends/i);
  });

  it('falls back to the recorded window when the period is left alone', async () => {
    const result = await runSimulation(
      USER,
      config({ periodIsDefault: true, startDate: '', endDate: '' }),
    );
    // The series runs 2024-12-03 to 2025-04-01. The default window is the most
    // recent 90 days (2025-01-02 onwards), and it is never allowed to start
    // earlier than the 28-day lead-in the engine needs to estimate an opening
    // stock — here the lead-in would have allowed 2024-12-31, so the window
    // bound is the one that applies.
    expect(result.start).toBe('2025-01-02');
    expect(result.end).toBe('2025-04-01');
  });
});

describe('the period', () => {
  it('includes both ends of the window', async () => {
    const result = await runSimulation(USER, config({ startDate: '2025-03-01', endDate: '2025-03-05' }));
    expect(result.chart.map((point) => point.date)).toEqual([
      '2025-03-01',
      '2025-03-02',
      '2025-03-03',
      '2025-03-04',
      '2025-03-05',
    ]);
  });

  it('prices the stockouts at the cost the caller supplied', async () => {
    const cheap = await runSimulation(USER, config({ stockoutCost: 1 }));
    const dear = await runSimulation(USER, config({ stockoutCost: 5000 }));
    expect(dear.kpis.stockoutCost).toBeGreaterThan(cheap.kpis.stockoutCost);
    // The cost assumptions are what is being priced, not what is being
    // replayed, so the operational metrics are untouched.
    expect(dear.kpis.stockoutDays).toBe(cheap.kpis.stockoutDays);
    expect(dear.kpis.averageInventory).toBe(cheap.kpis.averageInventory);
  });
});
