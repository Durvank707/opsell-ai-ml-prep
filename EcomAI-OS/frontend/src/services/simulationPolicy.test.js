// The simulation's vocabulary: the four policies, the two forecasting methods,
// and the two custom parameters.
//
// These strings are duplicated from `src/inventory/policy_profiles.py`, which is
// the authority — the server is what actually resolves a policy. The
// duplication is deliberate (the form has to offer the policies before any run
// has happened) and it is therefore pinned here: a rename on either side fails
// a test instead of shipping a form that offers "Conservative" while the server
// calls it something else.

import { describe, expect, it } from 'vitest';
import {
  COMPARABLE_POLICY_KEYS,
  CUSTOM_POLICY_FIELDS,
  CUSTOM_POLICY_KEY,
  FORECAST_METHODS,
  INVENTORY_POLICIES,
  POLICY_LOOKUP,
  SIMULATION_DISCLAIMER,
  SIMULATION_SCOPE,
  SIMULATION_SCOPE_NOTE,
  customPolicyParams,
  policyLabel,
} from './simulationPolicy';

describe('scope', () => {
  it('is one product, because the engine has no portfolio mode', () => {
    expect(SIMULATION_SCOPE).toBe('single_product');
  });

  it('explains why the whole catalog is not an option, rather than omitting it', () => {
    expect(SIMULATION_SCOPE_NOTE).toMatch(/portfolio simulation is not available yet/i);
    expect(SIMULATION_SCOPE_NOTE).toMatch(/one product at a time/i);
  });

  it('says the run changes nothing real', () => {
    expect(SIMULATION_DISCLAIMER).toMatch(/historical backtest/i);
    expect(SIMULATION_DISCLAIMER).toMatch(/does not change your real inventory/i);
    expect(SIMULATION_DISCLAIMER).toMatch(/does not .*place real purchase orders/i);
  });
});

describe('the policy catalogue', () => {
  it('offers exactly the four keys the server accepts, in the server order', () => {
    expect(INVENTORY_POLICIES.map((policy) => policy.key)).toEqual([
      'current',
      'conservative',
      'aggressive',
      'custom',
    ]);
  });

  it('describes the current policy as the standard EcomAI-OS rules', () => {
    expect(POLICY_LOOKUP.current.label).toBe('Current Policy');
    expect(POLICY_LOOKUP.current.description).toBe(
      'Uses the standard EcomAI-OS replenishment rules.',
    );
  });

  it('leaves the current policy unscaled, so a run reproduces live V2 exactly', () => {
    // 1.0 safety and 1.0 coverage is what makes "Current Policy" a faithful
    // replay of the live recommendation rather than a fourth opinion about it.
    expect(POLICY_LOOKUP.current.safetyMultiplier).toBe(1);
    expect(POLICY_LOOKUP.current.coverageMultiplier).toBe(1);
  });

  it('varies only the safety-stock buffer between the presets', () => {
    expect(POLICY_LOOKUP.conservative.safetyMultiplier).toBe(1.5);
    expect(POLICY_LOOKUP.aggressive.safetyMultiplier).toBe(0.5);
    // Coverage stays on the supplier lead time under every preset, so the
    // presets differ in buffer size and nothing else.
    for (const policy of INVENTORY_POLICIES) {
      expect(policy.coverageMultiplier).toBe(1);
    }
  });

  it('says which way each preset trades off, without claiming a winner', () => {
    expect(POLICY_LOOKUP.conservative.description).toMatch(/more safety inventory/i);
    expect(POLICY_LOOKUP.conservative.description).toMatch(/stockout risk/i);
    expect(POLICY_LOOKUP.aggressive.description).toMatch(/leaner inventory/i);
    expect(POLICY_LOOKUP.aggressive.description).toMatch(/holding cost/i);
    for (const policy of INVENTORY_POLICIES) {
      expect(policy.description).not.toMatch(/\b(best|winner|optimal|recommended)\b/i);
    }
  });

  it('marks custom as the only policy that takes parameters', () => {
    expect(CUSTOM_POLICY_KEY).toBe('custom');
    const accepting = INVENTORY_POLICIES.filter((policy) => policy.acceptsCustom);
    expect(accepting.map((policy) => policy.key)).toEqual([CUSTOM_POLICY_KEY]);
  });

  it('compares only the fixed presets, because custom has no fixed column', () => {
    expect(COMPARABLE_POLICY_KEYS).toEqual(['current', 'conservative', 'aggressive']);
    expect(COMPARABLE_POLICY_KEYS).not.toContain(CUSTOM_POLICY_KEY);
  });

  it('labels a key it has never heard of without throwing', () => {
    expect(policyLabel('aggressive')).toBe('Aggressive');
    expect(policyLabel('nonsense')).toBe('nonsense');
    expect(policyLabel(undefined)).toBe('Unknown policy');
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
