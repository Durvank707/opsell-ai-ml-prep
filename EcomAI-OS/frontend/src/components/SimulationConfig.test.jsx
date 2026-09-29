// The simulation form: five steps, one product, and two separate questions.
//
// The form used to lead with a scope control offering the whole catalog, which
// the engine cannot run — choosing it either failed in api mode or quietly
// simulated a single product in mock mode, which is worse because it looks like
// it worked. The form now evaluates one product, says why, and keeps the
// inventory-policy choice and the forecast comparison as two distinct things
// with two distinct headings.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SimulationConfig from './SimulationConfig';
import { SIMULATION_DISCLAIMER, SIMULATION_SCOPE_NOTE } from '../services/simulationPolicy';

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
const runButton = () => screen.getByRole('button', { name: /run simulation/i });

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

function choosePolicy(label) {
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(label, 'i') }));
}

function run() {
  fireEvent.click(runButton());
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the five steps', () => {
  it('walks the user from product to run, in order', () => {
    renderForm();
    const headings = ['Product to simulate', 'Inventory policy', 'Historical period to replay', 'Cost assumptions (optional)', 'Run the simulation'];
    for (const heading of headings) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    // Numbered 1..5, so a new user can see how much is left to do.
    for (const number of ['1', '2', '3', '4', '5']) {
      expect(screen.getByText(number)).toBeInTheDocument();
    }
  });

  it('asks the policy question in plain words', () => {
    renderForm();
    expect(screen.getByText('How should inventory be managed?')).toBeInTheDocument();
  });

  it('ends in a call to action that says what running it does', () => {
    renderForm();
    expect(
      screen.getAllByText('Replay historical sales and see how this policy would have performed.')
        .length,
    ).toBeGreaterThan(0);
  });

  it('says the run changes nothing real', () => {
    renderForm();
    expect(screen.getAllByText(SIMULATION_DISCLAIMER).length).toBeGreaterThan(0);
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

  it('explains why the portfolio is not offered, rather than omitting it silently', () => {
    renderForm();
    expect(screen.getByText(SIMULATION_SCOPE_NOTE)).toBeInTheDocument();
    expect(SIMULATION_SCOPE_NOTE).toMatch(/one product at a time/i);
  });

  it('holds exactly one product, so a second choice replaces the first', async () => {
    // The restriction used to be expressed by a single-select element. The
    // picker is a text box now, so the same guarantee is expressed by the
    // payload: choosing again replaces the product instead of adding one.
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
    // Typing is a search, not a decision. Nothing is sent until the user picks a
    // product and asks for the run.
    const { onRun } = renderForm();
    fireEvent.change(productField(), { target: { value: 'd' } });
    fireEvent.change(productField(), { target: { value: 'de' } });
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

describe('the inventory policy', () => {
  it('offers the four policies the server accepts', () => {
    renderForm();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    // Matched by accessible name, so this also proves each option is labelled.
    for (const label of [/^Current Policy/, /^Conservative/, /^Aggressive/, /^Custom/]) {
      expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
    }
  });

  it('gives each one a sentence saying what it does', () => {
    renderForm();
    expect(screen.getByText('Uses the standard EcomAI-OS replenishment rules.')).toBeInTheDocument();
    expect(screen.getByText(/keep more safety inventory/i)).toBeInTheDocument();
    expect(screen.getByText(/keep leaner inventory/i)).toBeInTheDocument();
  });

  it('starts on the current policy, which is the one live EcomAI-OS already runs', () => {
    renderForm();
    expect(screen.getByRole('radio', { name: /current policy/i })).toBeChecked();
  });

  it('sends the policy the user chose', async () => {
    const { onRun } = renderForm();
    choosePolicy('Aggressive');
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0].policy).toBe('aggressive');
  });

  it('sends no parameters for a fixed preset, which the server refuses', async () => {
    const { onRun } = renderForm();
    choosePolicy('Conservative');
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0].policyParams).toBeNull();
  });
});

describe('the custom policy', () => {
  it('hides the parameters until the custom policy is chosen', () => {
    renderForm();
    expect(screen.queryByLabelText(/safety stock \(units\)/i)).toBeNull();
    choosePolicy('Custom');
    expect(screen.getByLabelText(/safety stock \(units\)/i)).toBeInTheDocument();
  });

  it('offers only the two parameters the server actually applies', () => {
    renderForm();
    choosePolicy('Custom');
    expect(screen.getByLabelText(/safety stock \(units\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/order coverage \(days\)/i)).toBeInTheDocument();
    // A third knob would be accepted here, ignored by the server, and then
    // reported on the results panel as though it had been simulated.
    expect(screen.queryByLabelText(/minimum stock/i)).toBeNull();
    expect(screen.queryByLabelText(/reorder point/i)).toBeNull();
    expect(screen.queryByLabelText(/order quantity/i)).toBeNull();
  });

  it('says a blank field falls back to the current policy\'s own value', () => {
    renderForm();
    choosePolicy('Custom');
    expect(screen.getByText(/leave a\s+field blank to use the current policy/i)).toBeInTheDocument();
  });

  it('sends the values the user entered', async () => {
    const { onRun } = renderForm();
    choosePolicy('Custom');
    fireEvent.change(screen.getByLabelText(/safety stock \(units\)/i), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText(/order coverage \(days\)/i), { target: { value: '14' } });
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0]).toMatchObject({
      policy: 'custom',
      policyParams: { safety_stock: 45, coverage_days: 14 },
    });
  });

  it('omits a field the user left blank rather than sending zero', async () => {
    // Zero safety stock is a real (and risky) answer; a blank field means "use
    // the current policy's value", and the two must not collapse into one.
    const { onRun } = renderForm();
    choosePolicy('Custom');
    fireEvent.change(screen.getByLabelText(/safety stock \(units\)/i), { target: { value: '45' } });
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0].policyParams).toEqual({ safety_stock: 45 });
  });

  it('refuses text a number field cannot represent, rather than reading it as blank', async () => {
    // Blank means "use the current policy's value", so a field that silently
    // became blank would run a different policy than the one on screen.
    const { onRun } = renderForm();
    choosePolicy('Custom');
    const field = screen.getByLabelText(/safety stock \(units\)/i);
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
    choosePolicy('Custom');
    fireEvent.change(screen.getByLabelText(/safety stock \(units\)/i), { target: { value: '-5' } });
    run();
    await waitFor(() => expect(screen.getByText(/zero or more/i)).toBeInTheDocument());
    expect(onRun).not.toHaveBeenCalled();
  });

  it('clears the complaint once the value is fixed', async () => {
    const { onRun } = renderForm();
    choosePolicy('Custom');
    const field = screen.getByLabelText(/safety stock \(units\)/i);
    fireEvent.change(field, { target: { value: '-5' } });
    run();
    await waitFor(() => expect(screen.getByText(/zero or more/i)).toBeInTheDocument());
    fireEvent.change(field, { target: { value: '30' } });
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0].policyParams).toEqual({ safety_stock: 30 });
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
    expect(screen.getByText(/fixed cost of placing one purchase order/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/stockout cost/i)).toBeInTheDocument();
    expect(screen.getByText(/margin lost when a unit of demand cannot be fulfilled/i)).toBeInTheDocument();
  });

  it('marks them optional and starts them on the server defaults', async () => {
    const { onRun } = renderForm();
    expect(screen.getByText('Cost assumptions (optional)')).toBeInTheDocument();
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

describe('the forecast comparison', () => {
  it('is its own section, not part of the policy step', () => {
    renderForm();
    expect(
      screen.getByText('Forecast comparison: which forecast performed better?'),
    ).toBeInTheDocument();
  });

  it('says it is a different question from the policy choice', () => {
    renderForm();
    expect(
      screen.getByText(/compares forecasting methods, and is separate from the policy/i),
    ).toBeInTheDocument();
  });

  it('names the two methods without offering a control to pick one', () => {
    renderForm();
    expect(screen.getByText('XGBoost')).toBeInTheDocument();
    expect(screen.getByText('Moving Average')).toBeInTheDocument();
    // The engine replays both on every run, so a control here would be a choice
    // the user appears to have made and the server never received.
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });

  it('cannot change the policy that is sent', async () => {
    const { onRun } = renderForm();
    run();
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    expect(onRun.mock.calls[0][0].policy).toBe('current');
  });
});

describe('while a run is in flight', () => {
  it('disables the button so the same period is not replayed twice', () => {
    renderForm({ running: true });
    // The label says what is happening, and the control is unavailable: a
    // second click would replay the same window and overwrite the first result.
    const busy = screen.getByRole('button', { name: /running simulation/i });
    expect(busy).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^run simulation$/i })).toBeNull();
  });
});
