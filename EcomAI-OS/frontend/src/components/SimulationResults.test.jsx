// The results panel: the inventory answer first, the graph for every strategy,
// and the model evaluation kept out of the way.
//
// The panel used to highlight a "best" column and label the moving-average arm
// as the "AI Policy", which told a reader that the backtest had proved something
// it had not. The next design made the customer pick a strategy before running,
// which asked them to answer the question the page exists to answer. These tests
// pin the replacement: a comparative summary, a full strategy table, one graph
// per strategy behind tabs, the custom arm present only when it was simulated,
// and the model evaluation collapsed and unranked.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The chart is exercised by the forecast page's tests. Here it would only add a
// recharts render between the panel's text and the assertions about it — but the
// points it is handed are exactly what the tabs are being tested for, so the
// stub records them.
const chartCalls = [];
vi.mock('./charts', () => ({
  StockLineChart: (props) => {
    chartCalls.push(props);
    return <div data-testid="stock-chart" />;
  },
}));

const { default: SimulationResults } = await import('./SimulationResults');
const { toSimulationResult } = await import('../services/simulationResult');
const {
  INVENTORY_POLICIES,
  MODEL_DETAILS_NOTE,
  POLICY_COMPARISON_NOTE,
  POLICY_TABS_NOTE,
  SIMULATION_DISCLAIMER,
} = await import('../services/simulationPolicy');

const strategyDescription = (key) =>
  INVENTORY_POLICIES.find((entry) => entry.key === key).description;

beforeEach(() => {
  chartCalls.length = 0;
});

function metrics(overrides = {}) {
  return {
    stockout_days: 2,
    lost_sales_units: 14,
    service_level: 96.4,
    average_inventory: 41.5,
    maximum_inventory: 88,
    number_of_orders: 6,
    total_units_ordered: 310,
    holding_cost: 1200.5,
    ordering_cost: 3000,
    stockout_cost: 14000,
    total_inventory_cost: 18200.5,
    ...overrides,
  };
}

function policyRow(key, label, overrides = {}) {
  return {
    key,
    label,
    description: strategyDescription(key),
    safety_stock: 20,
    coverage_days: 7,
    average_reorder_point: 74.5,
    average_order_up_to: 74.5,
    stockout_days: 2,
    stockout_units: 14,
    service_level: 96.4,
    average_inventory: 41.5,
    maximum_inventory: 88,
    excess_inventory: 12.25,
    number_of_orders: 6,
    total_units_ordered: 310,
    holding_cost: 1200.5,
    ordering_cost: 3000,
    stockout_cost: 14000,
    total_inventory_cost: 18200.5,
    ...overrides,
  };
}

function timeline({ closingStock = 50, reorderPoint = 74.5, inTransit = 0, lost = 0, orderQty = 0 } = {}) {
  return [
    {
      date: '2025-01-01',
      demand: 11,
      arrival_qty: 0,
      units_fulfilled: 11,
      stockout_units: 0,
      closing_stock: closingStock,
      open_order_units: inTransit,
      inventory_position: closingStock + inTransit,
      order_qty: orderQty,
      reorder_required: orderQty > 0,
      reorder_point: reorderPoint,
      target_inventory: reorderPoint,
      safety_stock: 20,
    },
    {
      date: '2025-01-02',
      demand: 40,
      arrival_qty: inTransit,
      units_fulfilled: lost ? 20 : 40,
      stockout_units: lost || 20,
      closing_stock: 12,
      open_order_units: 0,
      inventory_position: 12,
      order_qty: 0,
      reorder_required: false,
      reorder_point: reorderPoint,
      target_inventory: reorderPoint,
      safety_stock: 20,
    },
  ];
}

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
      policyRow('current', 'Current Policy'),
      policyRow('conservative', 'Conservative', {
        safety_stock: 30,
        stockout_days: 0,
        service_level: 100,
        average_inventory: 61.2,
        number_of_orders: 7,
        total_inventory_cost: 24500,
      }),
      policyRow('aggressive', 'Aggressive', {
        safety_stock: 10,
        stockout_days: 5,
        service_level: 90.1,
        average_inventory: 28.4,
        number_of_orders: 9,
        total_inventory_cost: 22100,
      }),
    ],
    policy_timelines: {
      current: timeline({ closingStock: 50, reorderPoint: 74.5, lost: 20, orderQty: 40 }),
      conservative: timeline({ closingStock: 80, reorderPoint: 84.5 }),
      aggressive: timeline({ closingStock: 25, reorderPoint: 64.5, lost: 20, inTransit: 30 }),
    },
    xgb_metrics: metrics(),
    baseline_metrics: metrics({ stockout_days: 4, service_level: 92, average_inventory: 33 }),
    cost_comparison: { recommended_strategy: 'xgboost', expected_savings: 3899.5 },
    ...overrides,
  };
}

/** A run that also replayed the optional custom strategy. */
function customPayload() {
  const body = payload({
    policies_evaluated: ['current', 'conservative', 'aggressive', 'custom'],
    policy: { ...payload().policy, key: 'custom', parameters: { safety_stock: 200 } },
  });
  body.policy_comparison = [
    ...body.policy_comparison,
    policyRow('custom', 'Custom', { safety_stock: 200, coverage_days: 12 }),
  ];
  body.policy_timelines = {
    ...body.policy_timelines,
    custom: timeline({ closingStock: 300, reorderPoint: 254.5 }),
  };
  return body;
}

function renderResults(resultOverrides = {}, props = {}) {
  const onRunAnother = vi.fn();
  const result = toSimulationResult(payload(resultOverrides), { mode: 'api' });
  render(<SimulationResults results={result} onRunAnother={onRunAnother} {...props} />);
  return { result, onRunAnother };
}

/** True when `a` is earlier in the document than `b`. */
function comesBefore(a, b) {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function cardAfter(text) {
  return screen.getByText(text).closest('section');
}

const headerRow = (table) => within(table).getAllByRole('columnheader').map((cell) => cell.textContent);

const dataRows = (table) => within(table).getAllByRole('row').slice(1);

// A metric label such as "Service Level" also appears as a table column, so the
// card is picked out by the uppercase styling that only the cards use.
const kpiLabel = (text) =>
  screen
    .getAllByText(text)
    .find((node) => typeof node.className === 'string' && node.className.includes('uppercase'));

const kpiCard = (text) => kpiLabel(text).parentElement;

const tab = (name) => screen.getByRole('tab', { name });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the answer, before the numbers', () => {
  it('asks the question the page is for, in the heading', () => {
    renderResults();
    expect(
      screen.getByRole('heading', { name: /how did the inventory strategies perform/i }),
    ).toBeInTheDocument();
  });

  it('leads with a comparative sentence rather than a verdict', () => {
    renderResults();
    const summary = cardAfter(/over the 90 recorded days/i);
    expect(summary.textContent).toMatch(/stockouts ranged from 0 to 5 days/);
    expect(summary.textContent).toMatch(/average inventory ranged from 28 to 61 units/);
  });

  it('puts that sentence before the table and the graph', () => {
    renderResults();
    const summary = screen.getByText(/over the 90 recorded days/i);
    expect(comesBefore(summary, screen.getByText('Policy comparison'))).toBe(true);
    expect(comesBefore(summary, screen.getByText('Inventory over time'))).toBe(true);
  });

  it('names the product, the period and how many strategies were compared', () => {
    renderResults();
    const heading = screen.getByRole('heading', {
      name: /how did the inventory strategies perform/i,
    });
    const header = heading.parentElement;
    expect(header.textContent).toMatch(/Wireless Headphones/);
    expect(header.textContent).toMatch(/90 days/);
    expect(header.textContent).toMatch(/3 strategies compared/);
  });

  it('says the run changed nothing real', () => {
    renderResults();
    expect(screen.getAllByText(/This is a historical backtest\./).length).toBeGreaterThan(0);
    expect(screen.getAllByText(SIMULATION_DISCLAIMER).length).toBeGreaterThan(1);
  });
});

describe('the strategies, in words before numbers', () => {
  it('says what each one does, using the same wording as the form', () => {
    renderResults();
    const card = cardAfter('The strategies compared');
    const text = card.textContent;
    expect(text).toMatch(/Uses the standard EcomAI-OS replenishment rules\./);
    expect(text).toMatch(/Keeps a larger safety buffer to reduce stockout risk\./);
    expect(text).toMatch(/Uses a smaller safety buffer to keep inventory lean\./);
  });

  it('reports the safety buffer each one actually used', () => {
    renderResults();
    const text = cardAfter('The strategies compared').textContent;
    expect(text).toMatch(/Safety stock 20 units/);
    expect(text).toMatch(/Safety stock 30 units/);
    expect(text).toMatch(/Safety stock 10 units/);
  });

  it('names the trade-off instead of declaring a winner', () => {
    renderResults();
    expect(screen.getByText(POLICY_COMPARISON_NOTE)).toBeInTheDocument();
  });

  it('reports the custom parameters only when a custom run was made', () => {
    // A preset-only run has no parameters to report, and saying so beats printing
    // an empty list that reads like a value failed to load.
    renderResults();
    expect(screen.queryByText(/custom policy used:/i)).toBeNull();
  });

  it('names the parameters a custom run actually applied', () => {
    const result = toSimulationResult(customPayload(), { mode: 'api' });
    render(<SimulationResults results={result} onRunAnother={() => {}} />);
    expect(screen.getByText(/custom policy used:/i).textContent).toMatch(
      /Safety stock \(units\) 200/,
    );
  });
});

describe('the policy comparison', () => {
  it('has the columns a reader needs to see the trade-off', () => {
    renderResults();
    const table = within(cardAfter('Policy comparison')).getByRole('table');
    expect(headerRow(table)).toEqual([
      'Strategy',
      'Stockouts',
      'Service Level',
      'Average Inventory',
      'Excess Inventory',
      'Orders Placed',
      'Inventory Cost',
    ]);
  });

  it('lists all three presets, in the order the server sent them', () => {
    renderResults();
    const table = within(cardAfter('Policy comparison')).getByRole('table');
    const rows = dataRows(table);
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toMatch(/Current Policy/);
    expect(rows[1].textContent).toMatch(/Conservative/);
    expect(rows[2].textContent).toMatch(/Aggressive/);
  });

  it('shows the real numbers, so the trade-off is visible rather than asserted', () => {
    renderResults();
    const table = within(cardAfter('Policy comparison')).getByRole('table');
    const rows = dataRows(table);
    // Conservative: no stockouts, more stock, more cost. Aggressive: the reverse.
    expect(rows[1].textContent).toContain('0 days');
    expect(rows[2].textContent).toContain('5 days');
    expect(rows[1].textContent).toContain('100%');
    expect(rows[2].textContent).toContain('90.1%');
  });

  it('explains every column in a sentence, because a heading is not a definition', () => {
    renderResults();
    const card = cardAfter('Policy comparison');
    expect(within(card).getByText(/days when demand could not be fulfilled/i)).toBeInTheDocument();
    expect(within(card).getByText(/percentage of demand fulfilled without a stockout/i)).toBeInTheDocument();
    expect(within(card).getByText(/average amount of inventory held/i)).toBeInTheDocument();
    expect(within(card).getByText(/number of purchase orders created/i)).toBeInTheDocument();
    expect(within(card).getByText(/simulated cost under the selected cost assumptions/i)).toBeInTheDocument();
  });

  it('has no Custom row when the run did not simulate one', () => {
    renderResults();
    expect(within(cardAfter('Policy comparison')).getByRole('table').textContent).not.toMatch(
      /Custom/,
    );
  });

  it('adds a Custom row when the run simulated one', () => {
    const result = toSimulationResult(customPayload(), { mode: 'api' });
    render(<SimulationResults results={result} onRunAnother={() => {}} />);
    const rows = dataRows(within(cardAfter('Policy comparison')).getByRole('table'));
    expect(rows).toHaveLength(4);
    expect(rows[3].textContent).toMatch(/Custom/);
    // Its own numbers, not a copy of the row above it.
    expect(rows[3].textContent).toMatch(/Uses your selected safety parameters/);
    expect(rows[3].textContent).toContain('2 days');
    // The buffer the run used is stated with the strategy, not in the metrics
    // table, where it would be a seventh column of the same number.
    expect(cardAfter('The strategies compared').textContent).toMatch(/Safety stock 200 units/);
  });
});

describe('the inventory timeline, one tab per strategy', () => {
  it('opens on the first strategy, with a tab for each', () => {
    renderResults();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((node) => node.textContent)).toEqual([
      'Current Policy',
      'Conservative',
      'Aggressive',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('identifies the strategy on screen in the card header', () => {
    renderResults();
    const card = cardAfter('Inventory over time');
    expect(card.textContent).toMatch(/Inventory over time — Current Policy/);
  });

  it('switches datasets without re-running anything', () => {
    // The data is already in the result object. Clicking a tab only changes what
    // the panel reads, so the chart must be handed that strategy's own points.
    renderResults();
    expect(chartCalls).toHaveLength(1);
    expect(chartCalls[0].points[0].stock).toBe(50);
    expect(chartCalls[0].points[0].reorderPoint).toBe(74.5);

    fireEvent.click(tab('Conservative'));
    expect(chartCalls).toHaveLength(2);
    expect(chartCalls[1].points[0].stock).toBe(80);
    expect(chartCalls[1].points[0].reorderPoint).toBe(84.5);

    fireEvent.click(tab('Aggressive'));
    expect(chartCalls).toHaveLength(3);
    expect(chartCalls[2].points[0].stock).toBe(25);
    expect(chartCalls[2].points[0].reorderPoint).toBe(64.5);
  });

  it('moves the selected marker with the tab, so the header cannot lie', () => {
    renderResults();
    fireEvent.click(tab('Aggressive'));
    expect(tab('Aggressive')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Current Policy')).toHaveAttribute('aria-selected', 'false');
    expect(cardAfter('Inventory over time').textContent).toMatch(
      /Inventory over time — Aggressive/,
    );
  });

  it('keeps the selection when unrelated content is read, rather than resetting it', () => {
    renderResults();
    fireEvent.click(tab('Aggressive'));
    // No rerender-triggering interaction in between: the tab state is the
    // panel's, and it is not derived from a prop that could reset it.
    expect(tab('Aggressive')).toHaveAttribute('aria-selected', 'true');
    expect(chartCalls).toHaveLength(2);
  });

  it('adds no Custom tab when the run did not simulate one', () => {
    renderResults();
    expect(screen.queryByRole('tab', { name: 'Custom' })).toBeNull();
  });

  it('adds a Custom tab when the run simulated one', () => {
    const result = toSimulationResult(customPayload(), { mode: 'api' });
    render(<SimulationResults results={result} onRunAnother={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Custom' })).toBeInTheDocument();
  });

  it('plots the in-transit, order and unmet-demand activity the replay recorded', () => {
    renderResults();
    // Without these a dip in stock reads as a strategy that stopped ordering,
    // and an empty day reads as a rounding error.
    expect(chartCalls[0].inTransitKey).toBe('inTransit');
    expect(chartCalls[0].lostKey).toBe('lost');
    expect(chartCalls[0].points.some((point) => point.lost > 0)).toBe(true);
    expect(chartCalls[0].points.some((point) => point.orderQty > 0)).toBe(true);
  });

  it('says what the tabs are for', () => {
    renderResults();
    expect(screen.getByText(POLICY_TABS_NOTE)).toBeInTheDocument();
  });

  it('reports the stockout and reorder activity in words as well as on the graph', () => {
    renderResults();
    expect(screen.getByText(/stock on hand fell to zero on 1 day/i)).toBeInTheDocument();
    expect(screen.getByText(/a reorder was triggered on 1 day/i)).toBeInTheDocument();
  });

  it('says so when a strategy came back with no timeline, rather than charting another', () => {
    renderResults({ policy_timelines: { current: timeline(), conservative: [], aggressive: [] } });
    fireEvent.click(tab('Conservative'));
    expect(
      screen.getByText(/no inventory timeline was returned for this strategy/i),
    ).toBeInTheDocument();
    // The panel switched, but drew nothing rather than borrowing Current's line.
    expect(chartCalls).toHaveLength(1);
  });
});

describe('the metrics of the strategy on screen', () => {
  it('shows the five explained business numbers, plus the cost', () => {
    renderResults();
    for (const label of [
      'Stockouts',
      'Service Level',
      'Average Inventory',
      'Excess Inventory',
      'Orders Placed',
      'Inventory Cost',
    ]) {
      expect(kpiLabel(label)).toBeInTheDocument();
    }
  });

  it('explains each one in a sentence, not just a number', () => {
    renderResults();
    expect(within(kpiCard('Stockouts')).getByText('2 days')).toBeInTheDocument();
    expect(within(kpiCard('Service Level')).getByText('96.4%')).toBeInTheDocument();
    expect(within(kpiCard('Average Inventory')).getByText('42 units')).toBeInTheDocument();
    expect(within(kpiCard('Orders Placed')).getByText('6')).toBeInTheDocument();
    expect(within(kpiCard('Inventory Cost')).getByText('₹18,201')).toBeInTheDocument();
    for (const label of ['Stockouts', 'Service Level', 'Average Inventory']) {
      expect(kpiCard(label).textContent.length).toBeGreaterThan(30);
    }
  });

  it('repeats the explanation as a tooltip, for a reader who hovers', () => {
    renderResults();
    expect(kpiCard('Service Level').getAttribute('title')).toMatch(
      /percentage of demand fulfilled/i,
    );
  });

  it('breaks the inventory cost down into its three parts', () => {
    renderResults();
    expect(
      within(kpiCard('Inventory Cost')).getByText(/Holding .*Orders .*Stockouts/i),
    ).toBeInTheDocument();
  });

  it('separates the stockout days from the units lost', () => {
    renderResults();
    expect(within(kpiCard('Stockouts')).getByText('14 units of demand lost')).toBeInTheDocument();
  });

  it('follows the tab, so the numbers always describe what the graph shows', () => {
    renderResults();
    expect(within(kpiCard('Average Inventory')).getByText('42 units')).toBeInTheDocument();
    fireEvent.click(tab('Conservative'));
    expect(within(kpiCard('Average Inventory')).getByText('61 units')).toBeInTheDocument();
  });
});

describe('the model evaluation, out of the way', () => {
  const modelSection = () => screen.getByText('Forecast model evaluation').closest('.card');

  it('is not part of the primary result', () => {
    renderResults();
    // The inventory answer is what the page is for; the model comparison is not
    // above the comparison table or inside the timeline.
    const comparison = cardAfter('Policy comparison');
    const details = modelSection();
    expect(comesBefore(comparison, details)).toBe(true);
    expect(comparison.textContent).not.toMatch(/XGBoost/);
    expect(cardAfter('Inventory over time').textContent).not.toMatch(/XGBoost/);
  });

  it('is collapsed by default, and says what it is for while collapsed', () => {
    renderResults();
    expect(modelSection().textContent).toMatch(MODEL_DETAILS_NOTE);
    // Collapsed means collapsed: the table is not in the document at all.
    expect(screen.queryByRole('table', { name: /forecast method/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/XGBoost/);
  });

  it('opens on request, with both methods and no verdict', () => {
    renderResults();
    const toggle = screen.getByRole('button', { name: /forecast model evaluation/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const table = within(modelSection()).getByRole('table');
    const rows = dataRows(table);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toMatch(/XGBoost/);
    expect(rows[1].textContent).toMatch(/Moving Average/);
    // No per-row verdict, even though the response named a recommended method.
    for (const row of rows) {
      expect(row.textContent).not.toMatch(/recommend|best|winner/i);
    }
  });

  it('says the comparison does not change the inventory policy', () => {
    renderResults();
    expect(screen.getAllByText(MODEL_DETAILS_NOTE).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /forecast model evaluation/i }));
    expect(
      screen.getByText(/fed the same recorded demand under the same inventory policy/i),
    ).toBeInTheDocument();
  });
});

describe('no winner, anywhere', () => {
  // Scoped to claims about a *strategy*. "Recommended order quantity" is the
  // name of what the replenishment rule computes, not advice about a policy, and
  // flagging it would push the wording out of the explanation the user needs.
  const VERDICT = /\bbest\b|\bwinner\b|recommended (strategy|policy|option)|\boptimal\b|AI Policy|\byou should\b|\branking\b/i;

  it('never labels a column or a row as the best one', () => {
    renderResults();
    expect(document.body.textContent).not.toMatch(VERDICT);
  });

  it('says the same with a custom run and the model section open', () => {
    // The full surface, not just the default view: a word that only appears once
    // a panel is expanded is still a word the customer can read.
    const result = toSimulationResult(customPayload(), { mode: 'api' });
    render(<SimulationResults results={result} onRunAnother={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /forecast model evaluation/i }));
    expect(document.body.textContent).not.toMatch(VERDICT);
  });

  it('does not turn a metric row into a highlight', () => {
    renderResults();
    for (const table of screen.getAllByRole('table')) {
      for (const cell of within(table).getAllByRole('cell')) {
        expect(cell.className).not.toMatch(/brand|emerald|green|ring-/);
      }
    }
  });
});

describe('how simulation works', () => {
  it('explains the day-by-day replay in order', () => {
    renderResults();
    const card = cardAfter('How simulation works');
    const text = within(card).getByRole('list').textContent;
    const steps = [
      'Historical sales',
      'Replay each day',
      'Demand reduces inventory',
      'Reorder rule is checked',
      'Purchase order is created',
      'Order arrives after lead time',
      'Metrics are calculated',
    ];
    let index = 0;
    for (const step of steps) {
      const found = text.indexOf(step, index);
      expect(found, `step after "${index}" should be ${step}`).toBeGreaterThanOrEqual(0);
      index = found + step.length;
    }
  });

  it('states the replenishment rule, so Current is not just a name', () => {
    renderResults();
    const card = cardAfter('How simulation works');
    expect(card.textContent).toMatch(/30-day demand forecast/);
    expect(card.textContent).toMatch(/lead-time demand \+ safety stock/);
    expect(card.textContent).toMatch(/reorder point/);
    expect(card.textContent).toMatch(/inventory position \(stock \+ open orders\)/);
    expect(card.textContent).toMatch(/recommended order quantity/);
    expect(card.textContent).toMatch(/same one the live recommendation uses/i);
  });
});

describe('a demo run is labelled as one', () => {
  it('says so in mock mode', () => {
    const result = toSimulationResult(payload(), { mode: 'mock' });
    render(<SimulationResults results={result} onRunAnother={() => {}} />);
    expect(screen.getByText(/demo data is in use/i)).toBeInTheDocument();
  });

  it('says nothing about demo data on a real run', () => {
    renderResults();
    expect(screen.queryByText(/demo data is in use/i)).toBeNull();
  });
});

describe('running another simulation', () => {
  it('offers a way back to the form', () => {
    const { onRunAnother } = renderResults();
    fireEvent.click(screen.getByRole('button', { name: /run another simulation/i }));
    expect(onRunAnother).toHaveBeenCalledTimes(1);
  });
});

describe('a thin response', () => {
  it('renders an empty comparison table rather than throwing', () => {
    renderResults({
      policy_comparison: [],
      policy_timelines: {},
      xgb_metrics: {},
      baseline_metrics: {},
      policy: { key: 'current', label: 'Current Policy' },
    });
    const table = within(cardAfter('Policy comparison')).getByRole('table');
    // A header and no rows: an empty table reads as "nothing to compare", which
    // is the truth, rather than a fabricated row of zeroes.
    expect(within(table).getAllByRole('row')).toHaveLength(1);
    // With one strategy there is nothing to switch between, so no tab strip.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByText(/no inventory timeline was returned/i)).toBeInTheDocument();
  });
});
