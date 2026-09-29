// The results panel: a plain-English answer first, then the numbers, and two
// comparisons that are not allowed to merge into one verdict.
//
// The panel used to highlight a "best" column and label the moving-average arm
// as the "AI Policy", which told a reader that the backtest had proved something
// it had not. These tests pin the replacement: the summary sentence, six
// explained business metrics, the two tables, and no winner anywhere.

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The chart is exercised by the forecast page's tests. Here it would only add
// a recharts render between the panel's text and the assertions about it.
vi.mock('./charts', () => ({
  StockLineChart: () => <div data-testid="stock-chart" />,
}));

const { default: SimulationResults } = await import('./SimulationResults');
const { toSimulationResult } = await import('../services/simulationResult');
const { SIMULATION_DISCLAIMER } = await import('../services/simulationPolicy');

function metrics(overrides = {}) {
  return {
    stockout_days: 2,
    lost_sales_units: 14,
    service_level: 96.4,
    average_inventory: 41.5,
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
    description: `${label} description`,
    safety_stock: 20,
    coverage_days: 7,
    average_reorder_point: 74.5,
    average_order_up_to: 74.5,
    stockout_days: 2,
    stockout_units: 14,
    service_level: 96.4,
    average_inventory: 41.5,
    excess_inventory: 12.25,
    number_of_orders: 6,
    total_units_ordered: 310,
    total_inventory_cost: 18200.5,
    ...overrides,
  };
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
    lead_time_days: 7,
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
    xgb_metrics: metrics(),
    baseline_metrics: metrics({ stockout_days: 4, service_level: 92, average_inventory: 33 }),
    cost_comparison: { recommended_strategy: 'xgboost', expected_savings: 3899.5 },
    daily_trajectory: [
      { date: '2025-01-01', xgb_closing_stock: 50, xgb_reorder_point: 74.5, xgb_open_order_units: 0 },
      { date: '2025-01-02', xgb_closing_stock: 12, xgb_reorder_point: 74.5, xgb_open_order_units: 62 },
    ],
    ...overrides,
  };
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

function tableAfter(heading) {
  // Each comparison is its own card, so the table under a heading is the one
  // that comparison renders.
  const card = heading.closest('section');
  return within(card).getByRole('table');
}

const headerRow = (table) => within(table).getAllByRole('columnheader').map((cell) => cell.textContent);

// A metric label such as "Service level" also appears as a table column, so the
// KPI is picked out by the uppercase styling that only the cards use.
const kpiLabel = (text) =>
  screen
    .getAllByText(text)
    .find((node) => typeof node.className === 'string' && node.className.includes('uppercase'));

const kpiCard = (text) => kpiLabel(text).parentElement;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the answer, before the numbers', () => {
  it('leads with a sentence saying what would have happened', () => {
    renderResults();
    expect(
      screen.getByText(/this policy would have experienced 2 stockout days/i),
    ).toBeInTheDocument();
  });

  it('puts that sentence before the chart and both tables', () => {
    renderResults();
    const summary = screen.getByText(/this policy would have experienced/i);
    expect(comesBefore(summary, screen.getByText('Inventory level over time'))).toBe(true);
    expect(comesBefore(summary, screen.getByText('Policy comparison'))).toBe(true);
    expect(comesBefore(summary, screen.getByText('Forecast comparison'))).toBe(true);
  });

  it('names the product, the period and the policy it judged', () => {
    renderResults();
    const heading = screen.getByRole('heading', { name: /simulation results/i });
    const header = heading.parentElement;
    expect(header.textContent).toMatch(/Wireless Headphones/);
    expect(header.textContent).toMatch(/90 days/);
    expect(header.textContent).toMatch(/Current Policy/);
  });

  it('shows the levels the run actually used, not the ones that were asked for', () => {
    renderResults();
    expect(screen.getByText(/effective policy: safety stock 20 units/i)).toBeInTheDocument();
    expect(screen.getByText(/reordering at about 75 units/i)).toBeInTheDocument();
  });

  it('says the run changed nothing real', () => {
    renderResults();
    expect(screen.getByText(/This is a historical backtest\./)).toBeInTheDocument();
  });
});

describe('the metrics, each explained', () => {
  const CARDS = [
    ['Stockout days', '2', /demand was larger than the stock available/i],
    ['Service level', '96.4%', /fulfilled from stock, rather than lost/i],
    ['Average inventory', '42', /average units held in stock/i],
    ['Excess inventory', '15', /above the policy's own safety stock buffer/i],
    ['Orders placed', '6', /purchase orders this policy would have placed/i],
    ['Inventory cost', '₹18,201', /holding cost, plus the fixed cost of each order/i],
  ];

  it('shows the six business numbers a reader acts on', () => {
    renderResults();
    for (const [label] of CARDS) {
      expect(kpiLabel(label)).toBeInTheDocument();
    }
  });

  it('explains each one in a sentence, not just a number', () => {
    renderResults();
    for (const [label, value, helper] of CARDS) {
      const card = kpiCard(label);
      expect(within(card).getByText(value)).toBeInTheDocument();
      expect(within(card).getByText(helper)).toBeInTheDocument();
    }
  });

  it('repeats the explanation as a tooltip, for a reader who hovers', () => {
    renderResults();
    expect(kpiCard('Service level').getAttribute('title')).toMatch(/fulfilled from stock/i);
  });

  it('breaks the inventory cost down into its three parts', () => {
    renderResults();
    expect(within(kpiCard('Inventory cost')).getByText(/holding .*orders .*stockouts/i)).toBeInTheDocument();
  });

  it('separates the stockout days from the units lost', () => {
    renderResults();
    expect(within(kpiCard('Stockout days')).getByText('14 units of demand lost')).toBeInTheDocument();
  });
});

describe('the policy comparison', () => {
  it('has the columns a reader needs to see the trade-off', () => {
    renderResults();
    const table = tableAfter(screen.getByText('Policy comparison'));
    expect(headerRow(table)).toEqual([
      'Policy',
      'Stockouts',
      'Service level',
      'Avg inventory',
      'Orders',
      'Cost',
    ]);
  });

  it('lists the three fixed policies, each with the buffer it used', () => {
    renderResults();
    const table = tableAfter(screen.getByText('Policy comparison'));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toMatch(/Current Policy/);
    expect(rows[0].textContent).toMatch(/Safety stock 20 units/);
    expect(rows[1].textContent).toMatch(/Safety stock 30 units/);
    expect(rows[2].textContent).toMatch(/Safety stock 10 units/);
  });

  it('shows the real numbers, so the trade-off is visible rather than asserted', () => {
    renderResults();
    const table = tableAfter(screen.getByText('Policy comparison'));
    const rows = within(table).getAllByRole('row').slice(1);
    // Conservative: no stockouts, more stock, more cost. Aggressive: the reverse.
    expect(rows[1].textContent).toContain('0 days');
    expect(rows[2].textContent).toContain('5 days');
    expect(rows[1].textContent).toContain('100%');
    expect(rows[2].textContent).toContain('90.1%');
  });

  it('names the trade-off instead of declaring a winner', () => {
    renderResults();
    expect(
      screen.getByText(/trade-off between keeping more inventory and reducing stockout risk/i),
    ).toBeInTheDocument();
  });
});

describe('the forecast comparison', () => {
  it('is a separate table, with its own columns', () => {
    renderResults();
    const table = tableAfter(screen.getByText('Forecast comparison'));
    expect(headerRow(table)).toEqual([
      'Forecast method',
      'Stockouts',
      'Service level',
      'Avg inventory',
      'Cost',
    ]);
  });

  it('lists the two methods and what each one is', () => {
    renderResults();
    const table = tableAfter(screen.getByText('Forecast comparison'));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toMatch(/XGBoost/);
    expect(rows[0].textContent).toMatch(/trained demand model/i);
    expect(rows[1].textContent).toMatch(/Moving Average/);
    expect(rows[1].textContent).toMatch(/moving average of recent recorded demand/i);
  });

  it('says what the comparison is for, without picking a side', () => {
    renderResults();
    expect(screen.getByText('What this tells you')).toBeInTheDocument();
    expect(
      screen.getByText(/how the forecasting method affected the simulated inventory outcome/i),
    ).toBeInTheDocument();
  });
});

describe('no winner, anywhere', () => {
  it('never labels a column or a row as the best one', () => {
    renderResults();
    const text = document.body.textContent;
    expect(text).not.toMatch(/\bbest\b/i);
    expect(text).not.toMatch(/\bwinner\b/i);
    expect(text).not.toMatch(/recommended strategy/i);
    expect(text).not.toMatch(/\brecommended\b/i);
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
    const card = screen.getByText('How simulation works').closest('section');
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

  it('says stock on hand plus open orders is what the rule is measured against', () => {
    renderResults();
    expect(
      screen.getByText(/stock plus\s+everything already on order/i),
    ).toBeInTheDocument();
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
    screen.getByRole('button', { name: /run another simulation/i }).click();
    expect(onRunAnother).toHaveBeenCalledTimes(1);
  });
});

describe('a thin response', () => {
  it('renders an empty comparison table rather than throwing', () => {
    renderResults({
      policy_comparison: [],
      daily_trajectory: [],
      xgb_metrics: {},
      baseline_metrics: {},
      policy: { key: 'current', label: 'Current Policy' },
    });
    const policyTable = tableAfter(screen.getByText('Policy comparison'));
    // A header and no rows: an empty table reads as "nothing to compare", which
    // is the truth, rather than a fabricated row of zeroes.
    expect(within(policyTable).getAllByRole('row')).toHaveLength(1);
    // The method rows still come from the two forecasts the run always made.
    const methodTable = tableAfter(screen.getByText('Forecast comparison'));
    expect(within(methodTable).getAllByRole('row')).toHaveLength(3);
  });
});
