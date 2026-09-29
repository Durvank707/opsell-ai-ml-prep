// The Simulation page: the searchable product picker feeding one backtest.
//
// The picker replaced a <select> over the whole catalog, which in a real tenant
// is hundreds of rows. What matters at page level is not the search itself —
// that is tested in the combobox — but what the page does with it:
//
//   1. the product id the picker reports is the one the simulation API is sent,
//      so a run is never made against the wrong product or a stale one;
//   2. typing a query is a search, not a request. A picker that reached the
//      network per keystroke would fire a request per character and, worse,
//      make the run's cost depend on how fast someone types.
//
// The page's own loads (the catalog and the recorded demand range) happen once
// on mount. Everything after that is local.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = { id: 'tenant-a', email: 'a@example.com' };
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const refresh = vi.fn();

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: USER }),
}));

vi.mock('../context/DataContext', () => ({
  useData: () => ({ refresh }),
}));

vi.mock('../context/ToastContext', () => ({
  useToast: () => toast,
}));

const inventory = vi.hoisted(() => ({ listProducts: vi.fn() }));
vi.mock('../services/inventoryService', () => inventory);

const sales = vi.hoisted(() => ({ getSalesData: vi.fn() }));
vi.mock('../services/salesService', () => sales);

const simulation = vi.hoisted(() => ({ runSimulation: vi.fn() }));
vi.mock('../services/simulationService', () => simulation);

// The results panel has its own tests and needs a full backtest payload to
// render. What is under test here is what happens *before* a result exists —
// which product the run is scoped to — so the panel is stubbed out.
vi.mock('../components/SimulationResults', () => ({
  default: () => <div>simulation results</div>,
}));

import SimulationPage from './SimulationPage';

const PRODUCTS = [
  {
    id: 'P001',
    name: 'Wireless Headphones',
    sku: 'AUD-100',
    category: 'Electronics',
    leadTimeDays: 7,
    currentStock: 60,
  },
  {
    id: 'P002',
    name: 'Desk Lamp',
    sku: 'LGT-200',
    category: 'Home',
    leadTimeDays: 5,
    currentStock: 22,
  },
  {
    id: 'P003',
    name: 'Standing Desk Mat',
    sku: 'DSK-300',
    category: 'Office',
    leadTimeDays: 12,
    currentStock: 0,
  },
];

const RESULT = { ok: true };

const box = () => screen.getByLabelText(/^product$/i);
const runButton = () => screen.getByRole('button', { name: /run simulation/i });

/** Search the picker and take the first match, as a user would. */
function chooseProduct(query) {
  fireEvent.change(box(), { target: { value: query } });
  fireEvent.mouseDown(screen.getAllByRole('option')[0]);
}

async function renderPage() {
  render(<SimulationPage />);
  await waitFor(() => expect(screen.getByLabelText(/^product$/i)).toBeInTheDocument());
}

/** Every network call the page has made, for the "nothing else was sent" checks. */
function callsMade() {
  return [...inventory.listProducts.mock.calls, ...sales.getSalesData.mock.calls];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  inventory.listProducts.mockResolvedValue({ items: PRODUCTS });
  sales.getSalesData.mockResolvedValue({ dateFrom: '2024-12-01', dateTo: '2025-03-31' });
  simulation.runSimulation.mockResolvedValue(RESULT);
});

describe('searching for the product to simulate', () => {
  it('loads the catalog once and then searches it in memory', async () => {
    await renderPage();
    expect(inventory.listProducts).toHaveBeenCalledTimes(1);
    // The whole catalog is already here, so a query is a comparison, not a
    // request.
    expect(callsMade()).toHaveLength(2);
  });

  it('finds a product by name and offers its id and category', async () => {
    await renderPage();
    fireEvent.change(box(), { target: { value: 'desk lamp' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toMatch(/Desk Lamp/);
    expect(options[0].textContent).toMatch(/P002/);
    expect(options[0].textContent).toMatch(/Home/);
  });

  it('does not leave the already-chosen product in the results of a search', async () => {
    // The form starts on the first product in the catalog. Searching for a
    // different one must not offer the old choice as if it matched, or the run
    // can be made against a product the user just typed past.
    await renderPage();
    fireEvent.change(box(), { target: { value: 'desk lamp' } });
    const options = screen.getAllByRole('option');
    expect(options.some((option) => /Wireless Headphones/.test(option.textContent))).toBe(
      false,
    );
  });

  it('finds a product by its product id, in any case', async () => {
    await renderPage();
    fireEvent.change(box(), { target: { value: '  p003 ' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toMatch(/Standing Desk Mat/);
  });

  it('makes no request at all while the user types', async () => {
    await renderPage();
    const before = callsMade().length;
    for (const query of ['s', 'st', 'sta', 'stand', 'standing', 'standing desk mat']) {
      fireEvent.change(box(), { target: { value: query } });
    }
    expect(callsMade()).toHaveLength(before);
    expect(simulation.runSimulation).not.toHaveBeenCalled();
  });

  it('makes no request when a search finds nothing', async () => {
    await renderPage();
    const before = callsMade().length;
    fireEvent.change(box(), { target: { value: 'telescope' } });
    expect(screen.getByText('No product found')).toBeInTheDocument();
    expect(callsMade()).toHaveLength(before);
  });

  it('still holds the previously chosen product after a failed search', async () => {
    // A search that finds nothing must not clear the selection: the run stays
    // available against the product the user already picked.
    await renderPage();
    fireEvent.change(box(), { target: { value: 'telescope' } });
    fireEvent.click(runButton());
    await waitFor(() => expect(simulation.runSimulation).toHaveBeenCalledTimes(1));
    expect(simulation.runSimulation.mock.calls[0][1].productIds).toEqual(['P001']);
  });
});

describe('the run the picker produces', () => {
  it('sends the product that was picked, by id', async () => {
    await renderPage();
    chooseProduct('Desk Lamp');
    fireEvent.click(runButton());
    await waitFor(() => expect(simulation.runSimulation).toHaveBeenCalledTimes(1));
    const config = simulation.runSimulation.mock.calls[0][1];
    expect(config.productIds).toEqual(['P002']);
  });

  it('sends the user, unchanged, alongside the config', async () => {
    await renderPage();
    chooseProduct('Desk Lamp');
    fireEvent.click(runButton());
    await waitFor(() => expect(simulation.runSimulation).toHaveBeenCalled());
    expect(simulation.runSimulation.mock.calls[0][0]).toEqual(USER);
  });

  it('picks the product the id was typed as, not the first match by name', async () => {
    await renderPage();
    // "P003" is the standing desk mat; the page must not substitute a product
    // whose name happens to share a word with the query.
    fireEvent.change(box(), { target: { value: 'P003' } });
    fireEvent.mouseDown(screen.getAllByRole('option')[0]);
    fireEvent.click(runButton());
    await waitFor(() => expect(simulation.runSimulation).toHaveBeenCalled());
    expect(simulation.runSimulation.mock.calls[0][1].productIds).toEqual(['P003']);
  });

  it('replaces the product on a second choice, never sending both', async () => {
    await renderPage();
    chooseProduct('Desk Lamp');
    chooseProduct('Standing Desk Mat');
    fireEvent.click(runButton());
    await waitFor(() => expect(simulation.runSimulation).toHaveBeenCalledTimes(1));
    const config = simulation.runSimulation.mock.calls[0][1];
    expect(config.productIds).toEqual(['P003']);
  });

  it('leaves every other part of the payload as the form set it', async () => {
    await renderPage();
    chooseProduct('Desk Lamp');
    fireEvent.click(screen.getByRole('radio', { name: /conservative/i }));
    fireEvent.click(runButton());
    await waitFor(() => expect(simulation.runSimulation).toHaveBeenCalled());
    const config = simulation.runSimulation.mock.calls[0][1];
    expect(config).toMatchObject({
      productIds: ['P002'],
      policy: 'conservative',
      policyParams: null,
      orderingCost: 500,
      stockoutCost: 1000,
    });
  });

  it('runs once per click, not once per character', async () => {
    await renderPage();
    // Two searches and two choices, then a single click. Every keystroke along
    // the way is local filtering; only the click reaches the API.
    chooseProduct('Desk');
    chooseProduct('Standing');
    fireEvent.click(runButton());
    await waitFor(() => expect(simulation.runSimulation).toHaveBeenCalledTimes(1));
    expect(simulation.runSimulation.mock.calls[0][1].productIds).toEqual(['P003']);
  });
});
