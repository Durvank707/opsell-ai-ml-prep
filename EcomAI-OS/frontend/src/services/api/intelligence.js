// Portfolio intelligence: recommendations and the policy backtest, backed by the
// tenant API.
//
// The recommendation rows and the backtest both come from the same engines the
// inventory page reads, so a recommendation can never disagree with the numbers
// printed beside it.

import * as http from './http';
import { toRecommendation } from './adapters';
import { toSimulationResult } from '../simulationResult';
import { COMPARABLE_POLICY_KEYS, CUSTOM_POLICY_KEY } from '../simulationPolicy';

// ---------------------------------------------------------------- recommendations

export async function getRecommendations(user, { filter = 'all', category = null } = {}) {
  const raw = await http.fetchRecommendations(user, category);
  const all = (raw.items || []).map(toRecommendation);
  const counts = raw.counts || countByType(all);

  // A category the workspace does not have is refused by the server rather
  // than answered with an empty list, so an empty result here always means
  // "nothing in this filter needs action", never "that filter matched nothing".
  const filtered = filter === 'all' ? all : all.filter((row) => row.type === filter);
  return { items: filtered, counts, total: filtered.length, filter };
}

function countByType(items) {
  return {
    all: items.length,
    critical: items.filter((r) => r.type === 'critical').length,
    reorder: items.filter((r) => r.type === 'reorder').length,
    monitor: items.filter((r) => r.type === 'monitor').length,
    no_action: items.filter((r) => r.type === 'no_action').length,
  };
}

// ---------------------------------------------------------------- simulation

/**
 * Backtest one product's replenishment over its own recorded history.
 *
 * The user chooses no inventory strategy before running. One request asks the
 * server to replay every preset, and — when the optional custom experiment is
 * enabled — the custom strategy as well, so the whole comparison comes back at
 * once with a timeline per strategy:
 *
 * * ``policies`` — the strategies to replay. An unsupported key is refused
 *   server-side rather than silently dropped, so a typo cannot shrink the
 *   comparison without the page noticing.
 * * ``policy_params`` — the two values the custom strategy accepts. Sent only
 *   when the custom strategy is part of the run; a fixed-policy run refuses
 *   them rather than ignoring what it would never apply. This is what stops a
 *   preset and a custom value from travelling together.
 *
 * The engine replays a single product's own days, so a wider scope is refused
 * here rather than quietly answered for one of the products in it. That is the
 * whole point of the comparison: same product, same demand, same days.
 */
export async function runSimulation(user, config) {
  const productId = resolveProductId(config);
  const custom = Boolean(config.customEnabled);

  const result = await http.postBacktest(user, {
    product_id: productId,
    // An untouched period is left to the server, which derives the window from
    // this tenant's own history and reserves the lead-in the engine needs to
    // estimate a starting stock. Only a period the user actually chose is sent.
    start_date: config.periodIsDefault ? null : config.startDate || null,
    end_date: config.periodIsDefault ? null : config.endDate || null,
    ordering_cost_per_order: Number(config.orderingCost) || 500,
    stockout_cost_per_unit: Number(config.stockoutCost) || 1000,
    policies: custom
      ? [...COMPARABLE_POLICY_KEYS, CUSTOM_POLICY_KEY]
      : [...COMPARABLE_POLICY_KEYS],
    // The custom arm's parameters. The custom strategy is also named as the
    // primary so the server's top-level detail metrics describe the same arm the
    // user typed the numbers for.
    policy: custom ? CUSTOM_POLICY_KEY : 'current',
    policy_params: custom ? config.customParams || null : null,
  });

  return toSimulationResult(result, { ...config, mode: 'api' });
}

function resolveProductId(config) {
  const ids = config.productIds || [];
  if (ids.length === 0) {
    throw new Error('Choose a product to simulate.');
  }
  if (ids.length > 1) {
    throw new Error(
      'Simulation evaluates one product at a time so the comparison stays ' +
        'like-for-like. Choose a single product.',
    );
  }
  return ids[0];
}
