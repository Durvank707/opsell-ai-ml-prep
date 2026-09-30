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
  'Simulation evaluates one product at a time so the comparison remains ' +
  'like-for-like.';

/** What the page is actually doing, for someone who has never seen it before. */
export const SIMULATION_PURPOSE =
  'Simulation replays your historical inventory to show how different ' +
  'inventory strategies would have performed.';

/**
 * Forecasting is an input to the policy, never a policy of its own. Without
 * this sentence the results look like they contain a model choice the user made,
 * which they did not: EcomAI-OS decides how demand is forecast.
 */
export const FORECASTING_ROLE_NOTE =
  'Simulation evaluates inventory strategies. Forecasting is an internal input ' +
  'to those strategies — EcomAI-OS decides how demand is predicted, so ' +
  'comparing forecast models is evaluation, not something you choose here.';

export const SIMULATION_DISCLAIMER =
  'This is a historical backtest. It does not change your real inventory or ' +
  'place real purchase orders.';

/**
 * The inventory strategies the engine can replay.
 *
 * The user does not pick one of these before running. Every preset is evaluated
 * in the same run against the same recorded demand, so the results show the
 * comparison rather than one column of it; the list is here for the labels and
 * explanations the comparison and the tabs need.
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
    description: 'Keeps a larger safety buffer to reduce stockout risk.',
    safetyMultiplier: 1.5,
    coverageMultiplier: 1,
    acceptsCustom: false,
  },
  {
    key: 'aggressive',
    label: 'Aggressive',
    description: 'Uses a smaller safety buffer to keep inventory lean.',
    safetyMultiplier: 0.5,
    coverageMultiplier: 1,
    acceptsCustom: false,
  },
  {
    key: 'custom',
    label: 'Custom',
    description: 'Uses your selected safety parameters.',
    safetyMultiplier: 1,
    coverageMultiplier: 1,
    acceptsCustom: true,
  },
];

/** The presets every run evaluates, in the order the comparison lists them. */
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

/**
 * The forecasting methods, for the collapsed model-details section only. They
 * are evaluated by the server for model evaluation; they are not options the
 * user chooses, because EcomAI-OS controls which model forecasts live demand.
 */
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

/** Why model evaluation is not part of the inventory decision. */
export const MODEL_DETAILS_NOTE =
  'This section evaluates forecasting performance. It does not change your ' +
  'inventory policy.';

export const MODEL_DETAILS_MEANING =
  'Both forecast methods were fed the same recorded demand under the same ' +
  'inventory policy, so the difference between them is the forecasting method ' +
  'alone.';

/** Why the strategies differ, stated without picking one. */
export const POLICY_COMPARISON_NOTE =
  'Inventory strategies make different trade-offs between carrying more ' +
  'inventory and reducing stockout risk. Compare the metrics and inventory ' +
  'timeline to understand how each strategy behaved.';

/** The tab strip, which shows data already returned rather than re-running. */
export const POLICY_TABS_NOTE =
  'Use the tabs to see how the same product would have behaved under each ' +
  'inventory strategy.';

/**
 * The business metrics in the comparison, each with the sentence that explains
 * it. Ordered as a customer would read them: what went wrong, how much of demand
 * was met, what it cost to hold, and what it took to run.
 */
export const POLICY_METRICS = [
  {
    key: 'stockout_days',
    label: 'Stockouts',
    meaning: 'Days when demand could not be fulfilled because inventory was unavailable.',
    format: 'days',
  },
  {
    key: 'service_level',
    label: 'Service Level',
    meaning: 'Percentage of demand fulfilled without a stockout.',
    format: 'percent',
  },
  {
    key: 'average_inventory',
    label: 'Average Inventory',
    meaning: 'Average amount of inventory held during the simulation.',
    format: 'units',
  },
  {
    key: 'excess_inventory',
    label: 'Excess Inventory',
    meaning:
      'Average stock held above the safety buffer on days when it was not needed.',
    format: 'units',
  },
  {
    key: 'number_of_orders',
    label: 'Orders Placed',
    meaning: 'Number of purchase orders created during the simulation.',
    format: 'count',
  },
  {
    key: 'total_inventory_cost',
    label: 'Inventory Cost',
    meaning: 'Simulated cost under the selected cost assumptions.',
    format: 'currency',
  },
];

/** The cost assumptions, in the words the form asks the user in. */
export const COST_ASSUMPTIONS = [
  {
    name: 'ordering_cost_per_order',
    label: 'Ordering cost',
    meaning: 'Estimated cost each time a purchase order is placed.',
  },
  {
    name: 'stockout_cost_per_unit',
    label: 'Stockout cost',
    meaning: 'Estimated business cost when demand cannot be fulfilled.',
  },
];

/**
 * Words the results must never contain.
 *
 * A backtest can show how strategies behaved; it cannot know which one a
 * customer should adopt, and a highlighted column would read as advice the
 * simulation never gave. Pinned by tests over the rendered panel and by the
 * catalogue below, so new copy cannot reintroduce it.
 */
export const FORBIDDEN_RESULT_LANGUAGE = [
  'winner',
  'best policy',
  'recommended strategy',
  'optimal',
  'ranking',
  'you should',
  'we recommend',
];

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

/**
 * The replenishment rule the replay follows, spelled out for a reader who does
 * not know what a reorder point is. This is the same rule the live
 * recommendation uses, which is why the Current column is a faithful replay of
 * production rather than a separate model of it.
 */
export const REPLENISHMENT_RULE =
  '30-day demand forecast → lead-time demand + safety stock → reorder point → ' +
  'inventory position (stock + open orders) → recommended order quantity.';

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
