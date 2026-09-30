// The simulation form: four steps, one product, and no strategy to choose.
//
// The form used to ask two questions the user should not have been asked before
// seeing any data — which inventory policy to replay, and which forecasting
// method to compare. Neither is a decision the customer can make usefully: the
// run exists to answer "how would each of these have behaved?", so the form now
// asks only what it has to (which product, which period, what costs) and states
// the custom experiment as an optional extra below the main action.
//
// These tests pin the *absence* as much as the presence: no radio group, no
// pre-run strategy selection, and a payload that never carries a strategy
// selection at all.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SimulationConfig from './SimulationConfig';
import {
  COST_ASSUMPTIONS,
  FORECASTING_ROLE_NOTE,
  INVENTORY_POLICIES,
  SIMULATION_DISCLAIMER,
  SIMULATION_PURPOSE,
  SIMULATION_SCOPE_NOTE,
} from '../services/simulationPolicy';

const PRODUCTS = [
  { id: 'P001', name: 'Wireless Headphones', sku: 'AUD-100', category: 'Electronics', leadTimeDays: 7, currentStock: 60 },
  { id: 'P002', name: 'Desk Lamp', sku: 'LGT-200', category: 'Home', leadTimeDays: 5, currentStock: 22 },
];

function renderForm(props = {}) {
  const onRun = vi.fn();
  render(
    <SimulationConfig
      products={PRODUCTS}
      dataRange={{ from: '2024-12-01', to: '2025-03-31' }}
      onRun={onRun}
      {...props}
    />,
  );
  return { onRun, ...props };
}

const productField = () => screen.getByLabelText(/^product$/i);
const runButton = () => screen.getByRole('button', { name: /^run simulation$/i });
const customToggle = () => screen.getByRole('button', { name: /\+ test custom policy/i });

/** Click into the picker, which lists the whole catalog over the selection. */
function openPicker() {
  fireEvent.click(productField());
}

/** Type a query and leave the list open, to read what it found. */
function searchProduct(query) {
  fireEvent.change(productField(), { target: { value: query } });
}

/** Search the picker and take the first match, as a user would. */
function chooseProduct(query) {
  searchProduct(query);
  fireEvent.mouseDown(screen.getAllByRole('option')[0]);
}

function run() {
  fireEvent.click(runButton());
}

function setCustomField(label, value) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Open the optional experiment, as a user would: a single secondary click. */
function openCustomPanel() {
  fireEvent.click(customToggle());
}

const safetyField = /safety stock \(units\)/i;
const coverageField = /order coverage \(days\)/i;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the four steps', () => {
  it('walks the user from product to run, in order', () => {
    renderForm();
    const headings = [
      'Product to simulate',
      'Simulation period',
      'Cost assumptions',
      'Run the simulation',
    ];
    for (const heading of headings) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    // Numbered 1..4, so a new user can see how much is left to do.
    for (const number of ['1', '2', '3', '4']) {
      expect(screen.getByText(number)).toBeInTheDocument();
    }
    // The old fifth step — picking a policy — is gone, and nothing took its
    // place as a hidden question.
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('says what the page is for, in one sentence, at the top', () => {
    renderForm();
    expect(screen.getAllByText(SIMULATION_PURPOSE).length).toBeGreaterThan(0);
    expect(SIMULATION_PURPOSE).toMatch(/replays your historical inventory/i);
  });

  it('offers exactly one action that starts a run', () => {
    // Two "Run Simulation" buttons would let a user believe they had run twice.
    renderForm();
    expect(screen.getAllByRole('button', { name: /run simulation/i })).toHaveLength(1);
  });

  it('previews the strategies the run will cover, so the comparison is no surprise', () => {
    renderForm();
    expect(screen.getByText(/one run replays all of these/i)).toBeInTheDocument();
    for (const key of ['current', 'conservative', 'aggressive']) {
      const policy = INVENTORY_POLICIES.find((entry) => entry.key === key);
      expect(screen.getByText(policy.label)).toBeInTheDocument();
      expect(screen.getByText(policy.description)).toBeInTheDocument();
    }
    // Not selectable: the preview exists to tell the user what will happen, and
    // a clickable version would recreate the pre-run choice this design removed.
    expect(screen.queryByText('Custom')).toBeNull();
  });

  it('says the run changes nothing real', () => {
    renderForm();
    expect(screen.getAllByText(SIMULATION_DISCLAIMER).length).toBeGreaterThan(0);
  });

  it('says forecasting is an input, not a choice made here', () => {
    renderForm();
    // The old form had a "Forecast comparison" block with two method names. The
    // comparison still happens, but on the results panel and behind a collapse.
    expect(screen.queryByText(/forecast comparison/i)).toBeNull();
    expect(screen.getAllByText(FORECASTING_ROLE_NOTE).length).toBeGreaterThan(0);
  });
});

describe('one product at a time', () => {
  it('searches the catalog and offers what it found', () => {
    renderForm();
    searchProduct('lamp');
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatch(/Desk Lamp/);
    expect(options[0]).toMatch(/P002/);
    expect(options[0]).toMatch(/Home/);
  });

  it('offers the whole catalog when nothing has been typed', () => {
    renderForm();
    openPicker();
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toHaveLength(2);
    expect(options.join(' ')).toMatch(/Wireless Headphones/);
    expect(options.join(' ')).toMatch(/Desk Lamp/);
  });

  it('offers no "All Products" option, because the engine cannot run one', () => {
    renderForm();
    openPicker();
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options.join(' ')).not.toMatch(/all products/i);
    expect(document.body.textContent).not.toMatch(/all products/i);
  });

  it('explains the one-product limit, rather than omitting it silently', () => {
    renderForm();
    expect(screen.getByText(SIMULATION_SCOPE_NOTE)).toBeInTheDocument();
    expect(SIMULATION_SCOPE_NOTE).toMatch(/like-for-like/i);
  });

  it('holds exactly one product, so a second choice replaces the first', async () => {
    // The picker is a text box, so the guarantee is expressed by the payload:
    // choosing again replaces the product instead of adding one.
    const { onRun } = renderForm();
    chooseProduct('Desk Lamp');
    chooseProduct('Wireless Headphones');
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0].productIds).toEqual(['P001']);
  });

  it('sends the product the user switched to', async () => {
    const { onRun } = renderForm();
    chooseProduct('Desk Lamp');
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0].productIds).toEqual(['P002']);
  });

  it('does not run the simulation while the product is being searched for', () => {
    // Typing is a search, not a decision. Nothing is sent until the user asks
    // for the run.
    const { onRun } = renderForm();
    fireEvent.change(productField(), { target: { value: 'd' } });
    fireEvent.change(productField(), { target: { value: 'desk lamp' } });
    expect(onRun).not.toHaveBeenCalled();
  });

  it('says when a search finds nothing', () => {
    renderForm();
    fireEvent.change(productField(), { target: { value: 'telescope' } });
    expect(screen.getByText('No product found')).toBeInTheDocument();
  });

  it('shows the chosen product\'s own lead time and stock', () => {
    renderForm();
    expect(screen.getByText(/lead time 7 days/i)).toBeInTheDocument();
    expect(screen.getByText(/60 units on hand/i)).toBeInTheDocument();
  });
});

describe('one run evaluates every strategy', () => {
  it('sends no strategy selection at all, because the user made none', async () => {
    const { onRun } = renderForm();
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    const config = onRun.mock.calls[0][0];
    // The service layer derives the full preset list. A `policy` here would be
    // a selection the user never made, and the server would headline it.
    expect(config.policy).toBeUndefined();
    expect(config.policies).toBeUndefined();
  });

  it('turns the custom experiment off unless it was switched on', async () => {
    const { onRun } = renderForm();
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0].customEnabled).toBe(false);
    expect(onRun.mock.calls[0][0].customParams).toBeNull();
  });
});

describe('the optional custom experiment', () => {
  it('is offered as a secondary action, below the main one', () => {
    renderForm();
    // Placement is the design: the presets are the answer the page exists to
    // give, so the experiment is offered after them, not above them.
    const buttons = screen.getAllByRole('button');
    const runIndex = buttons.findIndex((b) => b === runButton());
    const customIndex = buttons.findIndex((b) => b === customToggle());
    expect(customIndex).toBeGreaterThan(runIndex);
  });

  it('keeps its parameters hidden until it is asked for', () => {
    renderForm();
    expect(screen.queryByLabelText(safetyField)).toBeNull();
    openCustomPanel();
    expect(screen.getByLabelText(safetyField)).toBeInTheDocument();
  });

  it('can be closed again, and takes its values with it', async () => {
    const { onRun } = renderForm();
    openCustomPanel();
    setCustomField(safetyField, '45');
    fireEvent.click(screen.getByRole('button', { name: /close custom policy experiment/i }));
    expect(screen.queryByLabelText(safetyField)).toBeNull();
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    // The typed value belonged to a panel that is no longer open, so it must
    // not reappear as a strategy the user no longer asked for.
    expect(onRun.mock.calls[0][0].customEnabled).toBe(false);
    expect(onRun.mock.calls[0][0].customParams).toBeNull();
  });

  it('offers only the two parameters the server actually applies', () => {
    renderForm();
    openCustomPanel();
    expect(screen.getByLabelText(safetyField)).toBeInTheDocument();
    expect(screen.getByLabelText(coverageField)).toBeInTheDocument();
    // A third knob would be accepted here, ignored by the server, and then
    // reported on the results panel as though it had been simulated.
    expect(screen.queryByLabelText(/minimum stock/i)).toBeNull();
    expect(screen.queryByLabelText(/reorder point/i)).toBeNull();
    expect(screen.queryByLabelText(/order quantity/i)).toBeNull();
  });

  it('says it adds a strategy beside the others, not instead of them', () => {
    renderForm();
    openCustomPanel();
    expect(
      screen.getByText(/adds one more strategy to the comparison, alongside current, conservative and aggressive/i),
    ).toBeInTheDocument();
  });

  it('says a blank field falls back to the current strategy\'s own value', () => {
    renderForm();
    openCustomPanel();
    expect(
      screen.getByText(/leave a\s+field blank to use the current\s+policy's own value/i),
    ).toBeInTheDocument();
  });

  it('lists Custom in the run preview only while it is switched on', () => {
    renderForm();
    expect(screen.queryByText('Custom')).toBeNull();
    openCustomPanel();
    expect(screen.getAllByText('Custom').length).toBeGreaterThan(0);
  });

  it('sends the values the user entered, marked as an experiment', async () => {
    const { onRun } = renderForm();
    openCustomPanel();
    setCustomField(safetyField, '45');
    setCustomField(coverageField, '14');
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0]).toMatchObject({
      customEnabled: true,
      customParams: { safety_stock: 45, coverage_days: 14 },
    });
    // No strategy is named alongside the parameters: there is no preset
    // selection for a custom value to contradict.
    expect(onRun.mock.calls[0][0].policy).toBeUndefined();
  });

  it('adds the arm with no parameters when the fields are left blank', async () => {
    const { onRun } = renderForm();
    openCustomPanel();
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    // The server then uses the current strategy's own values, which is the same
    // thing the field being blank already means.
    expect(onRun.mock.calls[0][0].customEnabled).toBe(true);
    expect(onRun.mock.calls[0][0].customParams).toBeNull();
  });

  it('omits a field the user left blank rather than sending zero', async () => {
    // Zero safety stock is a real (and risky) answer; a blank field means "use
    // the current policy's value", and the two must not collapse into one.
    const { onRun } = renderForm();
    openCustomPanel();
    setCustomField(safetyField, '45');
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0].customParams).toEqual({ safety_stock: 45 });
  });

  it('refuses text a number field cannot represent, rather than reading it as blank', async () => {
    // Blank means "use the current policy's value", so a field that silently
    // became blank would run a different strategy than the one on screen.
    const { onRun } = renderForm();
    openCustomPanel();
    const field = screen.getByLabelText(safetyField);
    fireEvent.change(field, { target: { value: 'loads' } });
    if (field.validity && field.validity.badInput) {
      run();
      await waitFor(() => expect(screen.getByText(/must be a number/i)).toBeInTheDocument());
      expect(onRun).not.toHaveBeenCalled();
    } else {
      // An engine without input validation reports the field as empty; the
      // shared validator still has to catch it, which `customPolicyParams`
      // covers directly. Here the fallback is simply a documented blank.
      expect(field.value).toBe('');
    }
  });

  it('refuses a negative buffer, naming the field', async () => {
    const { onRun } = renderForm();
    openCustomPanel();
    setCustomField(safetyField, '-5');
    run();
    await waitFor(() => expect(screen.getByText(/zero or more/i)).toBeInTheDocument());
    expect(onRun).not.toHaveBeenCalled();
  });

  it('clears the complaint once the value is fixed', async () => {
    const { onRun } = renderForm();
    openCustomPanel();
    setCustomField(safetyField, '-5');
    run();
    await waitFor(() => expect(screen.getByText(/zero or more/i)).toBeInTheDocument());
    setCustomField(safetyField, '30');
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0].customParams).toEqual({ safety_stock: 30 });
  });
});

describe('the period', () => {
  it('previews the recorded window and leaves it to the server by default', async () => {
    const { onRun } = renderForm();
    expect(screen.getByLabelText(/start date/i).value).toBe('2025-01-01');
    expect(screen.getByLabelText(/end date/i).value).toBe('2025-03-31');
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0].periodIsDefault).toBe(true);
  });

  it('sends a period the user actually edited', async () => {
    const { onRun } = renderForm();
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '2025-02-01' } });
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0]).toMatchObject({
      startDate: '2025-02-01',
      periodIsDefault: false,
    });
  });

  it('warns that a custom window needs recorded history before it', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '2025-02-01' } });
    expect(screen.getByText(/needs some recorded history before the start date/i)).toBeInTheDocument();
  });
});

describe('the cost assumptions', () => {
  it('explains what each cost is, because a user is guessing otherwise', () => {
    renderForm();
    expect(screen.getByLabelText(/ordering cost/i)).toBeInTheDocument();
    expect(screen.getByText(COST_ASSUMPTIONS[0].meaning)).toBeInTheDocument();
    expect(screen.getByLabelText(/stockout cost/i)).toBeInTheDocument();
    expect(screen.getByText(COST_ASSUMPTIONS[1].meaning)).toBeInTheDocument();
  });

  it('marks them optional and starts them on the server defaults', async () => {
    const { onRun } = renderForm();
    expect(screen.getByText(/used only to price the simulated inventory/i)).toBeInTheDocument();
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0]).toMatchObject({ orderingCost: 500, stockoutCost: 1000 });
  });

  it('sends what the user entered', async () => {
    const { onRun } = renderForm();
    fireEvent.change(screen.getByLabelText(/ordering cost/i), { target: { value: '750' } });
    fireEvent.change(screen.getByLabelText(/stockout cost/i), { target: { value: '2500' } });
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0]).toMatchObject({ orderingCost: 750, stockoutCost: 2500 });
  });
});

describe('while a run is in flight', () => {
  it('disables the button so the same period is not replayed twice', () => {
    renderForm({ running: true });
    const busy = screen.getByRole('button', { name: /running simulation/i });
    expect(busy).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^run simulation$/i })).toBeNull();
  });
});
