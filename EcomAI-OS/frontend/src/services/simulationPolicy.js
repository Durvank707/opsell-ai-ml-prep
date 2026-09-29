// The simulation's vocabulary, in one place.
//
// The Simulation page mixes two things that are easy to confuse: the *inventory
// policy* (how much stock to keep) and the *forecasting method* (which demand
// estimate the policy was fed). This module holds the words for both, plus the
// one-line explanations next to them, so the form and the results panel cannot
// describe the same thing two different ways.
//
// The policy keys, labels and descriptions here mirror
// `src/inventory/policy_profiles.py`. `tests/test_simulation_policy.py` pins the
// backend strings and `simulationPolicy.test.js` pins these, so a rename on
// either side fails a test instead of quietly shipping two vocabularies.

/** Exactly one product per run; the engine has no portfolio mode. */
export const SIMULATION_SCOPE = 'single_product';

export const SIMULATION_SCOPE_NOTE =
  'Portfolio simulation is not available yet. Simulation currently evaluates ' +
  'one product at a time so the comparison remains like-for-like.';

export const SIMULATION_DISCLAIMER =
  'This is a historical backtest. It does not change your real inventory or ' +
  'place real purchase orders.';

/**
 * The two independent comparisons the page offers. Kept apart because a policy
 * change and a forecasting change look similar in a table but answer different
 * questions.
 *
 * `safetyMultiplier` and `coverageMultiplier` mirror the constants in
 * `src/inventory/policy_profiles.py`. The server is always the authority on
 * them — the browser-only demo data source is the only thing that reads these,
 * so that a demo run follows the same rule as a real one instead of contradicting
 * it.
 */
export const INVENTORY_POLICIES = [
  {
    key: 'current',
    label: 'Current Policy',
    description: 'Uses the standard EcomAI-OS replenishment rules.',
    safetyMultiplier: 1,
    coverageMultiplier: 1,
    acceptsCustom: false,
  },
  {
    key: 'conservative',
    label: 'Conservative',
    description:
      'Keep more safety inventory to reduce stockout risk. Uses 1.5x the ' +
      'standard safety stock.',
    safetyMultiplier: 1.5,
    coverageMultiplier: 1,
    acceptsCustom: false,
  },
  {
    key: 'aggressive',
    label: 'Aggressive',
    description:
      'Keep leaner inventory to reduce holding cost, accepting more stockout ' +
      'risk. Uses 0.5x the standard safety stock.',
    safetyMultiplier: 0.5,
    coverageMultiplier: 1,
    acceptsCustom: false,
  },
  {
    key: 'custom',
    label: 'Custom',
    description: 'Set your own policy parameters.',
    safetyMultiplier: 1,
    coverageMultiplier: 1,
    acceptsCustom: true,
  },
];

/** The policies whose fixed parameters can be compared side by side. */
export const COMPARABLE_POLICY_KEYS = ['current', 'conservative', 'aggressive'];

export const CUSTOM_POLICY_KEY = 'custom';

/**
 * The only custom parameters the server applies. Anything else would be
 * accepted and then ignored, which would let the results panel show a number the
 * simulation never used. The `hint` for each field is the server's own wording
 * from `describe_custom_fields()`.
 */
export const CUSTOM_POLICY_FIELDS = [
  {
    name: 'safety_stock',
    label: 'Safety stock (units)',
    hint:
      'Extra stock kept on hand as a buffer against forecast error. A higher ' +
      'buffer reorders earlier and in larger lots.',
    placeholder: 'e.g. 40',
    min: 0,
    integer: true,
  },
  {
    name: 'coverage_days',
    label: 'Order coverage (days)',
    hint:
      'Days of forecast demand each purchase order must cover. The default ' +
      'equals the supplier lead time.',
    placeholder: 'e.g. 7',
    min: 0.5,
    integer: false,
  },
];

export const FORECAST_METHODS = [
  {
    key: 'xgboost',
    label: 'XGBoost',
    description: 'The trained demand model EcomAI-OS uses for live forecasts.',
  },
  {
    key: 'baseline',
    label: 'Moving Average',
    description: 'A 7-day moving average of recent recorded demand.',
  },
];

export const FORECAST_COMPARISON_NOTE =
  'Both methods are tested on the same historical product data so their ' +
  'inventory outcomes can be compared fairly.';

export const FORECAST_COMPARISON_MEANING =
  'The comparison shows how the forecasting method affected the simulated ' +
  'inventory outcome for this product and period.';

export const POLICY_COMPARISON_NOTE =
  'Use this comparison to understand the trade-off between keeping more ' +
  'inventory and reducing stockout risk. The user should draw the conclusion ' +
  'from the numbers.';

/** The engine's own order of operations, for the "How simulation works" strip. */
export const SIMULATION_STEPS = [
  'Historical sales',
  'Replay each day',
  'Demand reduces inventory',
  'Reorder rule is checked',
  'Purchase order is created',
  'Order arrives after lead time',
  'Metrics are calculated',
];

/** One day of cover someone might pick, in the order the form offers them. */
export const POLICY_LOOKUP = Object.fromEntries(
  INVENTORY_POLICIES.map((policy) => [policy.key, policy]),
);

export function policyLabel(key) {
  return POLICY_LOOKUP[key]?.label || key || 'Unknown policy';
}

function normalise(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * The custom parameters the server would accept, given the form's raw strings.
 *
 * Blank fields are omitted rather than sent as zero, because the server reads
 * "absent" as "use the current policy's own value" — sending `0` would mean
 * something quite different. Returns `{ params, error }`; `error` names the
 * first field that is not a number, so the form can refuse before a round trip.
 */
export function customPolicyParams(values = {}) {
  const params = {};
  for (const field of CUSTOM_POLICY_FIELDS) {
    const raw = normalise(values[field.name]);
    if (raw === '') continue;
    const number = Number(raw);
    if (!Number.isFinite(number)) {
      return { params: {}, error: `${field.label.replace(/\s*\(.*\)$/, '')} must be a number.` };
    }
    if (number < field.min) {
      const bound = field.min === 0 ? 'zero or more' : `at least ${field.min}`;
      return { params: {}, error: `${field.label.replace(/\s*\(.*\)$/, '')} must be ${bound}.` };
    }
    params[field.name] = field.integer ? Math.round(number) : number;
  }
  return { params, error: null };
}
