// The browser-only demo engine, the replenishment rule it replays, and the
// promise that one run covers every strategy.
//
// Mock mode is what a tenant sees with no backend, and it used to be a different
// formula wearing the same policy names: it sized the order from the whole
// 30-day forecast instead of the live replenishment rule (lead-time demand +
// safety stock, reorder point, order up to that point). These tests pin the
// corrected rule, pin that a strategy actually changes the outcome — a strategy
// that does not change anything is a label, not a strategy — and pin that a
// strategy nobody chose is still simulated, because the demo has to behave like
// the server it stands in for.

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

/** The run the form produces: no strategy chosen, no custom experiment. */
function config(overrides = {}) {
  return {
    productIds: [PRODUCT.id],
    customEnabled: false,
    customParams: null,
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

describe('one run covers every strategy', () => {
  it('simulates all three presets even though the user chose none', async () => {
    // The demo has to behave like the endpoint it stands in for. If it only
    // replayed one, the tabs would be showing the same line three times.
    const result = await runSimulation(USER, config());
    expect(result.strategies.map((row) => row.key)).toEqual([
      'current',
      'conservative',
      'aggressive',
    ]);
    expect(result.tabKeys).toEqual(['current', 'conservative', 'aggressive']);
  });

  it('hands back a separate history per strategy, over the same days', async () => {
    const result = await runSimulation(USER, config());
    const { current, conservative, aggressive } = result.strategiesByKey;
    const dates = result.strategies.map((row) => row.chart.map((point) => point.date));
    expect(dates[1]).toEqual(dates[0]);
    expect(dates[2]).toEqual(dates[0]);
    // Different buffers, so different order levels: otherwise the tabs would
    // be three copies of one line.
    expect(conservative.chart[0].reorderPoint).toBeGreaterThan(current.chart[0].reorderPoint);
    expect(aggressive.chart[0].reorderPoint).toBeLessThan(current.chart[0].reorderPoint);
  });

  it('opens on Current Policy, because that is what the user already runs', async () => {
    const result = await runSimulation(USER, config());
    expect(result.initialPolicyKey).toBe('current');
  });

  it('records what it replayed, so the activity feed can say so', async () => {
    const db = seed();
    await runSimulation(USER, config());
    expect(db.activity[0].description).toMatch(/across 3 inventory strategies/i);
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

  it('keeps the order-up-to level equal to the reorder point under every strategy', () => {
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

  it('falls back to the current strategy for a field the custom one omits', () => {
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
    expect(validateCustomParams({})).toBeNull();
    expect(validateCustomParams(null)).toBeNull();
  });

  it('refuses a parameter the server does not apply', () => {
    // A third knob would be accepted by the form, ignored by the server, and
    // then shown on the results panel as if it had been simulated.
    expect(validateCustomParams({ min_stock: 10 })).toMatch(
      /accepts only safety_stock and coverage_days/i,
    );
  });

  it('refuses a value that is not a number', () => {
    expect(validateCustomParams({ safety_stock: 'lots' })).toMatch(/must be a number/i);
  });

  it('refuses a negative buffer but accepts zero', () => {
    expect(validateCustomParams({ safety_stock: -1 })).toMatch(/zero or more/i);
    expect(validateCustomParams({ safety_stock: 0 })).toBeNull();
  });

  it('refuses a zero-day order, which would never arrive', () => {
    expect(validateCustomParams({ coverage_days: 0 })).toMatch(/greater than zero/i);
  });

  it('surfaces the refusal to the caller instead of running something else', async () => {
    await expect(
      runSimulation(
        USER,
        config({ customEnabled: true, customParams: { min_stock: 10 } }),
      ),
    ).rejects.toThrow(/accepts only safety_stock and coverage_days/i);
  });

  it('ignores parameters typed while the experiment was closed', async () => {
    // The panel is hidden, so its values are stale text the user never
    // submitted. Simulating them anyway would add a strategy nobody asked for.
    const result = await runSimulation(
      USER,
      config({ customEnabled: false, customParams: { safety_stock: 200 } }),
    );
    expect(result.hasCustom).toBe(false);
    expect(result.strategies.map((row) => row.key)).not.toContain('custom');
  });
});

describe('the custom strategy, when the experiment is enabled', () => {
  const customRun = (customParams) =>
    runSimulation(USER, config({ customEnabled: true, customParams }));

  it('is simulated beside the presets, not instead of them', async () => {
    const result = await customRun({ safety_stock: 60 });
    expect(result.strategies.map((row) => row.key)).toEqual([
      'current',
      'conservative',
      'aggressive',
      'custom',
    ]);
  });

  it('gets a tab of its own and a history of its own', async () => {
    const result = await customRun({ safety_stock: 60 });
    expect(result.tabKeys).toContain('custom');
    expect(result.strategiesByKey.custom.chart[0].reorderPoint).toBeGreaterThan(
      result.strategiesByKey.current.chart[0].reorderPoint,
    );
  });

  it('carries the supplied buffer all the way into the reported numbers', async () => {
    const result = await customRun({ safety_stock: 60 });
    expect(result.strategiesByKey.custom.safetyStock).toBe(60);
    expect(result.customParameters).toEqual({ safety_stock: 60 });
    // Still an order-up-to at the reorder point, with the bigger buffer.
    expect(result.strategiesByKey.custom.orderUpTo).toBeCloseTo(
      result.strategiesByKey.custom.reorderPoint,
      5,
    );
  });

  it('honours a supplied order coverage as well as a buffer', async () => {
    const result = await customRun({ safety_stock: 45, coverage_days: 14 });
    expect(result.strategiesByKey.custom.coverageDays).toBe(14);
  });

  it('is the primary arm, so the detail metrics describe what was typed', async () => {
    const result = await customRun({ safety_stock: 60 });
    expect(result.modelDetails.primaryKey).toBe('custom');
  });

  it('adds the arm even with no parameters, using the current strategy own values', async () => {
    const result = await customRun(null);
    expect(result.strategiesByKey.custom.safetyStock).toBe(20);
    expect(result.customParameters).toEqual({});
  });
});

describe('a strategy actually changes the outcome', () => {
  it('holds more stock under Conservative and less under Aggressive', async () => {
    const { current, conservative, aggressive } = (
      await runSimulation(USER, config())
    ).strategiesByKey;
    expect(aggressive.averageInventory).toBeLessThan(current.averageInventory);
    expect(current.averageInventory).toBeLessThan(conservative.averageInventory);
  });

  it('trades stockouts the other way, which is the whole point of the comparison', async () => {
    const { conservative, aggressive } = (
      await runSimulation(USER, config())
    ).strategiesByKey;
    expect(conservative.stockoutDays).toBeLessThanOrEqual(aggressive.stockoutDays);
    expect(conservative.serviceLevel).toBeGreaterThanOrEqual(aggressive.serviceLevel);
  });

  it('reports the buffer each strategy actually used', async () => {
    const { strategiesByKey } = await runSimulation(USER, config());
    expect(strategiesByKey.current.safetyStock).toBe(20);
    expect(strategiesByKey.conservative.safetyStock).toBe(30);
    expect(strategiesByKey.aggressive.safetyStock).toBe(10);
  });

  it('orders up to the reorder point, not to a month of demand', async () => {
    const { current } = (await runSimulation(USER, config())).strategiesByKey;
    // 7 days of demand at ~10 units plus a 20-unit buffer is about 90 units.
    // The 30-day forecast is about 300, and the old engine ordered that.
    expect(current.orderUpTo).toBeCloseTo(current.reorderPoint, 5);
    expect(current.orderUpTo).toBeLessThan(200);
  });

  it('leaves Current Policy unscaled, so it reproduces the live rule', async () => {
    const { current } = (await runSimulation(USER, config())).strategiesByKey;
    // The product's own configured buffer, with no multiplier applied.
    expect(current.safetyStock).toBe(PRODUCT.safetyStock);
  });
});

describe('the forecast evaluation', () => {
  it('scores both methods under the same strategy', async () => {
    const result = await runSimulation(USER, config());
    expect(result.modelDetails.methods.map((row) => row.key)).toEqual(['xgboost', 'baseline']);
    // Both arms ran under Current Policy, so the rows differ by the forecasting
    // method and nothing else.
    for (const row of result.modelDetails.methods) {
      expect(row.stockoutDays).toBeGreaterThanOrEqual(0);
      expect(row.serviceLevel).toBeGreaterThanOrEqual(0);
    }
    expect(result.modelDetails.primaryKey).toBe('current');
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
    expect(second.strategies).toEqual(first.strategies);
    expect(second.chart).toBeUndefined();
    expect(second.strategiesByKey.current.chart).toEqual(
      first.strategiesByKey.current.chart,
    );
  });

  it('replays the window it was given, day by day', async () => {
    const result = await runSimulation(USER, config());
    expect(result.start).toBe('2025-01-15');
    expect(result.end).toBe('2025-03-31');
    expect(result.durationDays).toBe(76);
    expect(result.strategiesByKey.current.chart).toHaveLength(76);
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
    expect(
      result.strategiesByKey.current.chart.map((point) => point.date),
    ).toEqual([
      '2025-03-01',
      '2025-03-02',
      '2025-03-03',
      '2025-03-04',
      '2025-03-05',
    ]);
  });

  it('prices the stockouts at the cost the caller supplied', async () => {
    const cheap = (await runSimulation(USER, config({ stockoutCost: 1 }))).strategiesByKey.current;
    const dear = (await runSimulation(USER, config({ stockoutCost: 5000 }))).strategiesByKey.current;
    expect(dear.stockoutCost).toBeGreaterThan(cheap.stockoutCost);
    // The cost assumptions are what is being priced, not what is being
    // replayed, so the operational metrics are untouched.
    expect(dear.stockoutDays).toBe(cheap.stockoutDays);
    expect(dear.averageInventory).toBe(cheap.averageInventory);
  });
});
