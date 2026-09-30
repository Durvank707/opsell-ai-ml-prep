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
//
// The layout tests at the end pin the page's shape: setup stacked above results,
// no split-screen grid, and no scroll container of its own. jsdom computes no
// layout, so those assert the structure and the classes that produce the
// behaviour rather than measuring boxes.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// which product the run is scoped to — and the page's shape around it, so the
// panel is stubbed with a deliberately long block of content: a real run's
// results are several screens tall, and that height is the whole reason the old
// split-screen layout misbehaved.
vi.mock('../components/SimulationResults', () => ({
  default: () => (
    <div data-testid="results-panel">
      <p>simulation results</p>
      {Array.from({ length: 30 }, (_, i) => (
        <div key={i} style={{ height: 200 }} data-testid={`result-block-${i}`} />
      ))}
    </div>
  ),
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

// The two labelled sections the page is now built from. A `<section>` with an
// `aria-labelledby` is a `region` landmark, so these are also how a screen reader
// jumps straight to the part it needs.
const setupRegion = () => screen.getByRole('region', { name: /configure simulation/i });
const resultsRegion = () => screen.getByRole('region', { name: /view results/i });

/** True when `a` comes earlier in the document than `b`. */
function before(a, b) {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

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
    fireEvent.click(runButton());
    await waitFor(() => expect(simulation.runSimulation).toHaveBeenCalled());
    const config = simulation.runSimulation.mock.calls[0][1];
    // No `policy`: the form asks the user to choose none, so the payload cannot
    // name one either. The service layer derives the full preset list.
    expect(config).toMatchObject({
      productIds: ['P002'],
      customEnabled: false,
      customParams: null,
      orderingCost: 500,
      stockoutCost: 1000,
    });
    expect(config.policy).toBeUndefined();
  });

  it('carries the custom experiment through, and only when it was switched on', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /\+ test custom policy/i }));
    fireEvent.change(screen.getByLabelText(/safety stock \(units\)/i), {
      target: { value: '45' },
    });
    fireEvent.click(runButton());
    await waitFor(() => expect(simulation.runSimulation).toHaveBeenCalled());
    expect(simulation.runSimulation.mock.calls[0][1]).toMatchObject({
      customEnabled: true,
      customParams: { safety_stock: 45 },
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

// The page used to be a five-column grid: the form pinned into the first two
// columns, the results in the other three. A real run's results run several
// screens long, so the grid row was as tall as the results, the pinned column
// scrolled out of view leaving a tall empty column beside it, and the inventory
// graph was confined to three fifths of the width.
//
// jsdom has no layout engine, so these tests cannot measure a column's width.
// What they can do — and what actually caused the bug — is check the structure:
// that the two sections are stacked block-level siblings, that nothing pins or
// scrolls the setup on its own, and that no result content is ever placed beside
// the form.
describe('the page runs top to bottom', () => {
  it('names both sections, so the order is the page’s structure', async () => {
    await renderPage();
    // A labelled <section> is a landmark. Configure → run → read is now
    // something a screen reader can navigate directly to.
    expect(setupRegion()).toBeInTheDocument();
    expect(resultsRegion()).toBeInTheDocument();
  });

  it('puts the setup section above the results section', async () => {
    await renderPage();
    expect(before(setupRegion(), resultsRegion())).toBe(true);
  });

  it('keeps the setup at the top and the results below it after a run', async () => {
    await renderPage();
    fireEvent.click(runButton());
    await waitFor(() => expect(screen.getByTestId('results-panel')).toBeInTheDocument());

    // The bug: the form sat in a sticky column that stayed put while the results
    // grew, so the two were level with each other for most of the scroll.
    expect(before(setupRegion(), screen.getByTestId('results-panel'))).toBe(true);
    expect(before(setupRegion(), resultsRegion())).toBe(true);
    expect(resultsRegion().contains(screen.getByTestId('results-panel'))).toBe(true);
  });

  it('shows the setup and an instruction state when nothing has been run', async () => {
    await renderPage();
    expect(setupRegion()).toBeInTheDocument();
    expect(screen.getByText(/ready to simulate/i)).toBeInTheDocument();
    expect(screen.queryByTestId('results-panel')).toBeNull();
  });

  it('tells the user where the product picker is, now that nothing is beside it', async () => {
    await renderPage();
    // "on the left" described the split screen. The picker is above, and saying
    // otherwise sends the user looking for a column that no longer exists.
    expect(screen.getByText(/ready to simulate/i).parentElement.textContent).toMatch(
      /choose a product above/i,
    );
    expect(document.body.textContent).not.toMatch(/choose a product on the left/i);
  });

  it('has no split-screen grid anywhere on the page', async () => {
    await renderPage();
    // The old wrapper was `grid ... xl:grid-cols-5` with `col-span-2` and
    // `col-span-3` children. Nothing places content in a column now.
    const offenders = Array.from(document.querySelectorAll('*')).filter(
      (node) =>
        /xl:grid-cols-5|col-span-2|col-span-3/.test(node.className || ''),
    );
    expect(offenders).toHaveLength(0);
  });

  it('stacks the two sections as siblings in one vertical flow', async () => {
    await renderPage();
    // Same parent, in order, as block-level flow. Siblings in a grid are what let
    // one column be as tall as the other.
    expect(setupRegion().parentElement).toBe(resultsRegion().parentElement);
    expect(before(setupRegion(), resultsRegion())).toBe(true);
  });
});

describe('nothing on the page scrolls on its own', () => {
  it('does not pin the setup section', async () => {
    await renderPage();
    // `sticky` plus `max-h-[calc(100vh-6rem)]` plus `overflow-y-auto` was a
    // scroll container inside a grid cell — the source of both the empty column
    // and the nested scrollbar.
    const offenders = Array.from(setupRegion().querySelectorAll('*')).filter((node) => {
      const cls = node.className || '';
      return /sticky|overflow-y-auto|overflow-auto|max-h-\[calc/.test(cls);
    });
    expect(offenders).toHaveLength(0);
  });

  it('leaves vertical scrolling to the page', async () => {
    await renderPage();
    fireEvent.click(runButton());
    await waitFor(() => expect(screen.getByTestId('results-panel')).toBeInTheDocument());

    // No element between the page root and the results declares its own height
    // or a vertical scroller, so a long run makes the document taller and the
    // browser scrolls once, at the page level.
    const offenders = Array.from(document.querySelectorAll('*')).filter((node) => {
      const cls = node.className || '';
      return /overflow-y-auto|overflow-auto|100vh|h-screen|max-h-\[/.test(cls);
    });
    expect(offenders.map((node) => node.className)).toEqual([]);
  });

  it('leaves long results to stack under a setup section of its own height', async () => {
    await renderPage();
    fireEvent.click(runButton());
    await waitFor(() => expect(screen.getByTestId('results-panel')).toBeInTheDocument());

    // The empty-column symptom needed the form to share a row with tall content:
    // a flex or grid item stretches, a block child does not. Nothing on either
    // side asks to be as tall as the other.
    const setup = setupRegion();
    const results = resultsRegion();
    for (const region of [setup, results]) {
      const cls = region.className || '';
      expect(cls).not.toMatch(/grid|flex|items-stretch|self-stretch|h-full/);
    }
    // And no wrapper places them in a shared row.
    const parent = setup.parentElement;
    expect(parent.className || '').not.toMatch(/\bflex\b|\bgrid\b/);
  });
});

// The page stacks two sections. They have to look like two panels of the same
// document, which means the same left and right edges — so neither may carry a
// width or offset class the other lacks. A cap on the form (it was `max-w-4xl`)
// left the setup card visibly narrower than the results under it.
describe('both sections are the same width', () => {
  it('gives the two sections identical boxes', async () => {
    await renderPage();
    // Neither <section> declares a class at all, so there is no max-width, no
    // fixed width and no margin offset that could make one box differ from the
    // other. The setup was once wrapped in `max-w-4xl`, which left it visibly
    // narrower than the results beneath it; this is the whole guarantee.
    expect(setupRegion().className).toBe('');
    expect(resultsRegion().className).toBe(setupRegion().className);
  });

  it('caps neither the setup nor the results', async () => {
    await renderPage();
    fireEvent.click(runButton());
    await waitFor(() => expect(screen.getByTestId('results-panel')).toBeInTheDocument());

    // Checked on the outermost box of each section, since a cap could be
    // reintroduced on the section itself or on a wrapper just inside it.
    const setupCard = setupRegion().querySelector('section.card');
    expect(setupCard).not.toBeNull();
    for (const node of [setupRegion(), setupCard, resultsRegion(), screen.getByTestId('results-panel')]) {
      expect(node.className || '').not.toMatch(/max-w-|w-\[/);
    }
  });

  it('does not narrow the form with an inner wrapper', async () => {
    await renderPage();
    // The form's card is a direct child of the section. One level in, nothing
    // sits between the section and the card to reintroduce a narrower measure.
    const children = [...setupRegion().children];
    expect(children).toHaveLength(2);
    expect(children[0].tagName).toBe('H2');
    expect(children[1].className).toBe('card');
    expect(setupRegion().querySelector('.max-w-4xl')).toBeNull();
  });

  it('puts no width cap between the results and the content area', async () => {
    await renderPage();
    fireEvent.click(runButton());
    await waitFor(() => expect(screen.getByTestId('results-panel')).toBeInTheDocument());

    // No `max-w-*` and no `w-*` on the results section or the panel stub, so the
    // comparison table and the inventory graph fill the content width — which is
    // what the old three-of-five-columns grid took away from them.
    for (const node of [resultsRegion(), screen.getByTestId('results-panel')]) {
      expect(node.className || '').not.toMatch(/max-w-|w-\[/);
    }
  });
});

describe('the setup is not repeated with the results', () => {
  it('renders the form once, in the setup section only', async () => {
    await renderPage();
    fireEvent.click(runButton());
    await waitFor(() => expect(screen.getByTestId('results-panel')).toBeInTheDocument());

    // One form, not a summary of it inside the results: the reader has just used
    // it, and a second copy below the fold is a second thing to keep in sync.
    expect(within(setupRegion()).getByLabelText(/^product$/i)).toBeInTheDocument();
    expect(within(resultsRegion()).queryByLabelText(/^product$/i)).toBeNull();
    expect(screen.getAllByLabelText(/^product$/i)).toHaveLength(1);
    expect(
      within(resultsRegion()).queryByText(/set up a simulation/i),
    ).toBeNull();
  });

  it('keeps the four steps and the one action after the move', async () => {
    await renderPage();
    // The layout change must not quietly drop a step or a second CTA.
    const setup = setupRegion();
    for (const step of [
      'Product to simulate',
      'Simulation period',
      'Cost assumptions',
      'Run the simulation',
    ]) {
      expect(within(setup).getByText(step)).toBeInTheDocument();
    }
    expect(within(setup).getAllByRole('button', { name: /run simulation/i })).toHaveLength(1);
    expect(within(setup).getByRole('button', { name: /\+ test custom policy/i })).toBeInTheDocument();
  });
});
