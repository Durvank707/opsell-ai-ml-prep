// The simulation's vocabulary: the four strategies, the two forecasting methods,
// the two custom parameters, and the words the results must never use.
//
// These strings are duplicated from `src/inventory/policy_profiles.py`, which is
// the authority — the server is what actually resolves a policy. The
// duplication is deliberate (the form has to name the strategies before any run
// has happened) and it is therefore pinned here: a rename on either side fails
// a test instead of shipping a form that offers "Conservative" while the server
// calls it something else.

import { describe, expect, it } from 'vitest';
import {
  COMPARABLE_POLICY_KEYS,
  COST_ASSUMPTIONS,
  CUSTOM_POLICY_FIELDS,
  CUSTOM_POLICY_KEY,
  FORBIDDEN_RESULT_LANGUAGE,
  FORECASTING_ROLE_NOTE,
  FORECAST_METHODS,
  INVENTORY_POLICIES,
  MODEL_DETAILS_NOTE,
  POLICY_COMPARISON_NOTE,
  POLICY_METRICS,
  POLICY_TABS_NOTE,
  REPLENISHMENT_RULE,
  SIMULATION_DISCLAIMER,
  SIMULATION_PURPOSE,
  SIMULATION_SCOPE,
  SIMULATION_SCOPE_NOTE,
  customPolicyParams,
  policyLabel,
} from './simulationPolicy';

describe('scope', () => {
  it('is one product, because the engine has no portfolio mode', () => {
    expect(SIMULATION_SCOPE).toBe('single_product');
  });

  it('explains the one-product limit, rather than omitting it', () => {
    expect(SIMULATION_SCOPE_NOTE).toMatch(/one product at a time/i);
    expect(SIMULATION_SCOPE_NOTE).toMatch(/like-for-like/i);
  });

  it('says what the page does, for someone who has never seen it', () => {
    expect(SIMULATION_PURPOSE).toMatch(/replays your historical inventory/i);
    expect(SIMULATION_PURPOSE).toMatch(/different\s+inventory strategies/i);
  });

  it('says the run changes nothing real', () => {
    expect(SIMULATION_DISCLAIMER).toMatch(/historical backtest/i);
    expect(SIMULATION_DISCLAIMER).toMatch(/does not change your real inventory/i);
    expect(SIMULATION_DISCLAIMER).toMatch(/does not .*place real purchase orders/i);
  });
});

describe('the strategy catalogue', () => {
  it('offers exactly the four keys the server accepts, in the server order', () => {
    expect(INVENTORY_POLICIES.map((policy) => policy.key)).toEqual([
      'current',
      'conservative',
      'aggressive',
      'custom',
    ]);
  });

  it('describes each strategy in the words the results use', () => {
    // Pinned verbatim against `policy_profiles.py`; a drift here would show two
    // different explanations for the same strategy on the same page.
    expect(policyDescription('current')).toBe(
      'Uses the standard EcomAI-OS replenishment rules.',
    );
    expect(policyDescription('conservative')).toBe(
      'Keeps a larger safety buffer to reduce stockout risk.',
    );
    expect(policyDescription('aggressive')).toBe(
      'Uses a smaller safety buffer to keep inventory lean.',
    );
    expect(policyDescription('custom')).toBe(
      'Uses your selected safety parameters.',
    );
  });

  it('describes the current strategy as the standard EcomAI-OS rules', () => {
    expect(policyDescription('current')).toMatch(/standard EcomAI-OS/i);
  });

  it('leaves the current strategy unscaled, so a run reproduces live V2 exactly', () => {
    // 1.0 safety and 1.0 coverage is what makes "Current Policy" a faithful
    // replay of the live recommendation rather than a fourth opinion about it.
    expect(current().safetyMultiplier).toBe(1);
    expect(current().coverageMultiplier).toBe(1);
  });

  it('varies only the safety-stock buffer between the presets', () => {
    expect(byKey('conservative').safetyMultiplier).toBe(1.5);
    expect(byKey('aggressive').safetyMultiplier).toBe(0.5);
    // Coverage stays on the supplier lead time under every preset, so the
    // presets differ in buffer size and nothing else.
    for (const policy of INVENTORY_POLICIES) {
      expect(policy.coverageMultiplier).toBe(1);
    }
  });

  it('says which way each preset trades off, without claiming a winner', () => {
    expect(policyDescription('conservative')).toMatch(/larger safety buffer/i);
    expect(policyDescription('conservative')).toMatch(/stockout risk/i);
    expect(policyDescription('aggressive')).toMatch(/smaller safety buffer/i);
    expect(policyDescription('aggressive')).toMatch(/lean/i);
    for (const policy of INVENTORY_POLICIES) {
      for (const phrase of FORBIDDEN_RESULT_LANGUAGE) {
        expect(policy.description.toLowerCase()).not.toContain(phrase);
      }
    }
  });

  it('marks custom as the only strategy that takes parameters', () => {
    expect(CUSTOM_POLICY_KEY).toBe('custom');
    const accepting = INVENTORY_POLICIES.filter((policy) => policy.acceptsCustom);
    expect(accepting.map((policy) => policy.key)).toEqual([CUSTOM_POLICY_KEY]);
  });

  it('compares only the fixed presets, because custom is opt-in', () => {
    expect(COMPARABLE_POLICY_KEYS).toEqual(['current', 'conservative', 'aggressive']);
    expect(COMPARABLE_POLICY_KEYS).not.toContain(CUSTOM_POLICY_KEY);
  });

  it('labels a key it has never heard of without throwing', () => {
    expect(policyLabel('aggressive')).toBe('Aggressive');
    expect(policyLabel('nonsense')).toBe('nonsense');
    expect(policyLabel(undefined)).toBe('Unknown policy');
  });
});

describe('the trade-off explanation', () => {
  it('explains why the strategies differ, and stops there', () => {
    expect(POLICY_COMPARISON_NOTE).toMatch(
      /different trade-offs between carrying more inventory and reducing stockout risk/i,
    );
    expect(POLICY_COMPARISON_NOTE).toMatch(/compare the metrics and inventory timeline/i);
    for (const phrase of FORBIDDEN_RESULT_LANGUAGE) {
      expect(POLICY_COMPARISON_NOTE.toLowerCase()).not.toContain(phrase);
    }
  });

  it('explains the tabs without implying the run is repeated', () => {
    expect(POLICY_TABS_NOTE).toMatch(
      /use the tabs to see how the same product would have behaved under each inventory strategy/i,
    );
  });

  it('states the replenishment rule the replay follows', () => {
    // The order matters: forecast, then lead-time demand plus safety stock, then
    // the reorder point, then the inventory position, then the order quantity.
    expect(REPLENISHMENT_RULE).toMatch(/30-day demand forecast/i);
    expect(REPLENISHMENT_RULE).toMatch(/lead-time demand \+ safety stock/i);
    expect(REPLENISHMENT_RULE).toMatch(/reorder point/i);
    expect(REPLENISHMENT_RULE).toMatch(/inventory position \(stock \+ open orders\)/i);
    expect(REPLENISHMENT_RULE).toMatch(/recommended order quantity/i);
  });
});

describe('the business metrics', () => {
  it('carries the five the comparison has to show', () => {
    expect(POLICY_METRICS.map((metric) => metric.key)).toEqual([
      'stockout_days',
      'service_level',
      'average_inventory',
      'excess_inventory',
      'number_of_orders',
      'total_inventory_cost',
    ]);
  });

  it('explains each one in a full sentence', () => {
    for (const metric of POLICY_METRICS) {
      expect(metric.label.length).toBeGreaterThan(3);
      expect(metric.meaning.length).toBeGreaterThan(20);
      expect(metric.meaning.endsWith('.')).toBe(true);
    }
    const byKeyName = Object.fromEntries(
      POLICY_METRICS.map((metric) => [metric.key, metric.meaning]),
    );
    expect(byKeyName.stockout_days).toMatch(
      /days when demand could not be fulfilled because inventory was unavailable/i,
    );
    expect(byKeyName.service_level).toMatch(
      /percentage of demand fulfilled without a stockout/i,
    );
    expect(byKeyName.average_inventory).toMatch(
      /average amount of inventory held during the simulation/i,
    );
    expect(byKeyName.number_of_orders).toMatch(
      /number of purchase orders created during the simulation/i,
    );
    expect(byKeyName.total_inventory_cost).toMatch(
      /simulated cost under the selected cost assumptions/i,
    );
  });

  it('puts the business metrics before the technical ones', () => {
    const order = POLICY_METRICS.map((metric) => metric.key);
    expect(order.indexOf('stockout_days')).toBeLessThan(order.indexOf('total_inventory_cost'));
  });
});

describe('the cost assumptions', () => {
  it('explains both costs in plain language', () => {
    expect(COST_ASSUMPTIONS.map((entry) => entry.name)).toEqual([
      'ordering_cost_per_order',
      'stockout_cost_per_unit',
    ]);
    expect(COST_ASSUMPTIONS[0].meaning).toMatch(
      /estimated cost each time a purchase order is placed/i,
    );
    expect(COST_ASSUMPTIONS[1].meaning).toMatch(
      /estimated business cost when demand cannot be fulfilled/i,
    );
  });
});

describe('the forecasting methods', () => {
  it('names the two the server actually replays', () => {
    expect(FORECAST_METHODS.map((method) => method.key)).toEqual(['xgboost', 'baseline']);
    expect(FORECAST_METHODS[0].label).toBe('XGBoost');
    expect(FORECAST_METHODS[1].label).toBe('Moving Average');
  });

  it('describes each one', () => {
    for (const method of FORECAST_METHODS) {
      expect(method.description.length).toBeGreaterThan(10);
    }
  });

  it('says model evaluation is not an inventory decision', () => {
    expect(MODEL_DETAILS_NOTE).toMatch(
      /evaluates forecasting performance\. it does not change your inventory policy/i,
    );
    for (const phrase of FORBIDDEN_RESULT_LANGUAGE) {
      expect(MODEL_DETAILS_NOTE.toLowerCase()).not.toContain(phrase);
    }
  });

  it('says forecasting is an input, not a choice the user makes', () => {
    expect(FORECASTING_ROLE_NOTE).toMatch(/evaluates inventory strategies/i);
    expect(FORECASTING_ROLE_NOTE).toMatch(/internal input/i);
    // EcomAI-OS picks the model, so the page must not read as if the user did.
    expect(FORECASTING_ROLE_NOTE).toMatch(/EcomAI-OS decides how demand is predicted/i);
  });
});

describe('custom policy parameters', () => {
  it('offers only the two the server applies', () => {
    // A third knob would be accepted by the form, ignored by the server, and
    // then shown on the results panel as if it had been simulated.
    expect(CUSTOM_POLICY_FIELDS.map((field) => field.name)).toEqual([
      'safety_stock',
      'coverage_days',
    ]);
  });

  it('omits a blank field rather than sending it as zero', () => {
    // Blank means "use the current policy's own value". Zero means "hold no
    // safety stock at all", which is a different and much riskier answer.
    const { params, error } = customPolicyParams({ safety_stock: '40', coverage_days: '' });
    expect(error).toBeNull();
    expect(params).toEqual({ safety_stock: 40 });
  });

  it('sends nothing when both fields are blank', () => {
    const { params, error } = customPolicyParams({ safety_stock: '', coverage_days: '  ' });
    expect(error).toBeNull();
    expect(params).toEqual({});
  });

  it('keeps a coverage value fractional and rounds a unit count', () => {
    const { params } = customPolicyParams({ safety_stock: '12.7', coverage_days: '9.5' });
    expect(params).toEqual({ safety_stock: 13, coverage_days: 9.5 });
  });

  it('refuses a value that is not a number, naming the field', () => {
    const { params, error } = customPolicyParams({ safety_stock: 'many' });
    expect(params).toEqual({});
    expect(error).toMatch(/safety stock/i);
    expect(error).toMatch(/must be a number/i);
  });

  it('refuses a negative buffer, because negative safety stock is not a policy', () => {
    const { params, error } = customPolicyParams({ safety_stock: '-5' });
    expect(params).toEqual({});
    expect(error).toMatch(/zero or more/i);
  });

  it('drops a field the server would not honour', () => {
    const { params, error } = customPolicyParams({
      safety_stock: '10',
      min_stock: '99',
      reorder_point: '500',
    });
    expect(error).toBeNull();
    expect(params).toEqual({ safety_stock: 10 });
  });
});

function byKey(key) {
  return INVENTORY_POLICIES.find((policy) => policy.key === key);
}

function current() {
  return byKey('current');
}

function policyDescription(key) {
  return byKey(key)?.description ?? '';
}
