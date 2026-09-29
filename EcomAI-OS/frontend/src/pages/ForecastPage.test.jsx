// The Forecast page: the portfolio/category forecast, and the product search
// that finds one product's own forecast.
//
// A row in the portfolio table reports a product's average daily demand but not
// its eligibility decision, so a new product arrived here looking identical to a
// settled one: zero average, zero forecast, and a "Stable" trend that was never
// calculated from demand. The row now says the history is missing, and every
// product that does have observed demand keeps its trend.
//
// The search used to filter those rows with an untrimmed comparison, which made
// matching depend on how a product happened to be typed and made a product with
// no forecast row unfindable by any spelling. It now normalizes the query and
// matches the catalog, then hands over to the existing product forecast page.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

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

const service = vi.hoisted(() => ({
  getForecastOverview: vi.fn(),
  generatePortfolioForecast: vi.fn(),
  getProductForecast: vi.fn(),
}));
vi.mock('../services/forecastService', () => service);

const inventory = vi.hoisted(() => ({ listProducts: vi.fn() }));
vi.mock('../services/inventoryService', () => inventory);

vi.mock('../services/settingsService', () => ({
  placeSimulatedOrder: vi.fn(),
}));

vi.mock('../components/charts', () => ({
  DemandChart: () => <div data-testid="demand-chart" />,
  StockLineChart: () => <div data-testid="stock-chart" />,
}));

const { default: ForecastPage } = await import('./ForecastPage');
const { default: ProductForecastPage } = await import('./ProductForecastPage');

/** A portfolio where one product has history and a second has none. */
const OVERVIEW = {
  horizon: 30,
  total: 586,
  avgDaily: 19.5,
  trend: 'stable',
  metrics: {
    avgExpectedDemand: 19.5,
    totalForecastUnits: 586,
    growing: 1,
    decreasing: 0,
    growthPct: 8.5,
  },
  chart: {
    actuals: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${i + 1}`, units: 18 })),
    forecast: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-10-${i + 1}`,
      forecast: 20,
      lower: 15,
      upper: 25,
    })),
  },
  rows: [
    {
      id: 'P001',
      name: 'Wireless Headphones',
      category: 'Electronics',
      current: 19.5,
      forecast: 586,
      forecastAvgDaily: 19.5,
      changePct: 8.5,
      trend: 'increasing',
      totalForecast: 586,
      fallbackUsed: 'ml',
    },
    {
      id: 'P006',
      name: 'Smart Fitness Band',
      category: 'Wearables',
      current: 0,
      forecast: 0,
      forecastAvgDaily: 0,
      changePct: 0,
      trend: 'stable',
      totalForecast: 0,
      fallbackUsed: 'baseline',
    },
  ],
  increasing: 1,
  decreasing: 0,
  stable: 0,
  productsForecasted: 2,
  productsInScope: 2,
  generatedAtLabel: 'a moment ago',
  generatedAt: '2026-09-29T00:00:00.000Z',
  howCalculated: ['Sum each product forecast.', 'Band it with the expected range.'],
};

/** The whole catalog, including a product that has no forecast row at all. */
const CATALOG = [
  { id: 'P001', name: 'Wireless Headphones', category: 'Electronics' },
  { id: 'P006', name: 'Smart Fitness Band', category: 'Wearables' },
  { id: 'P007', name: 'Wireless Mouse', category: 'Electronics' },
  { id: 'P008', name: 'Wireless Charger', category: 'Accessories' },
  { id: 'P012', name: 'Desk Lamp Pro', category: 'Home & Kitchen' },
];

const COLD_START_DESCRIPTION =
  'No ML forecast is generated because the product does not yet have enough sales history. A baseline estimate is shown instead while history accumulates.';

/** What the product endpoint returns for a product that has never sold a unit. */
const P006_FORECAST = {
  productId: 'P006',
  productName: 'Smart Fitness Band',
  category: 'Wearables',
  horizon: 30,
  points: [],
  actuals: [],
  total: 0,
  avgDaily: 0,
  peakDate: null,
  peakUnits: null,
  trend: 'stable',
  growthPct: 0,
  fallbackUsed: 'baseline',
  modelVersion: null,
  eligibility: {
    eligible: false,
    tier: 'cold_start',
    tier_label: 'Cold start',
    description: COLD_START_DESCRIPTION,
    confidence_label: 'insufficient_history',
  },
  warning: `Required fields are missing, so ML cannot run. A baseline is used instead. ${COLD_START_DESCRIPTION}`,
  mlUnavailable: false,
};

const P001_FORECAST = {
  productId: 'P001',
  productName: 'Wireless Headphones',
  category: 'Electronics',
  horizon: 30,
  points: Array.from({ length: 30 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    forecast: 18 + (i % 5),
    lower: 12 + (i % 5),
    upper: 24 + (i % 5),
  })),
  actuals: Array.from({ length: 60 }, (_, i) => ({
    date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
    units: 14 + (i % 6),
  })),
  total: 586.39,
  avgDaily: 19.55,
  peakDate: '2026-10-22',
  peakUnits: 22.02,
  trend: 'increasing',
  growthPct: 8.5,
  fallbackUsed: 'ml',
  modelVersion: 'xgboost-v1.0.0',
  eligibility: {
    eligible: true,
    tier: 'limited_history',
    tier_label: 'Limited history',
    description: 'The product has 90–179 days of history.',
    confidence_label: 'limited',
  },
  warning: null,
  mlUnavailable: false,
};

function rowFor(name) {
  return screen.getByText(name).closest('tr');
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/forecast']}>
      <ForecastPage />
    </MemoryRouter>,
  );
}

/** Both routes, as the app registers them, so a search can be followed. */
function renderWithRoutes() {
  return render(
    <MemoryRouter initialEntries={['/app/forecast']}>
      <Routes>
        <Route path="/app/forecast" element={<ForecastPage />} />
        <Route path="/app/products/:productId/forecast" element={<ProductForecastPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function searchBox() {
  return screen.getByPlaceholderText(/search a product/i);
}

async function typeSearch(text) {
  fireEvent.change(searchBox(), { target: { value: text } });
}

/** Wait for the search results to settle on the products the catalog holds. */
async function matchesShown(names) {
  await waitFor(() => expect(searchBox()).toBeInTheDocument());
  for (const name of names) {
    expect(await screen.findByText(name)).toBeInTheDocument();
  }
}

beforeEach(() => {
  service.getForecastOverview.mockReset();
  service.generatePortfolioForecast.mockReset();
  service.getProductForecast.mockReset();
  inventory.listProducts.mockReset();
  service.getForecastOverview.mockResolvedValue(OVERVIEW);
  inventory.listProducts.mockImplementation((_user, { page = 1, pageSize = 12 } = {}) => ({
    items: CATALOG.slice((page - 1) * pageSize, page * pageSize),
    total: CATALOG.length,
    page,
    pageSize,
  }));
  service.getProductForecast.mockImplementation((_user, productId) => {
    if (productId === 'P006') return Promise.resolve(P006_FORECAST);
    const product = CATALOG.find((p) => p.id === productId);
    return Promise.resolve({
      ...P001_FORECAST,
      productId,
      productName: product ? product.name : productId,
      category: product ? product.category : P001_FORECAST.category,
    });
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the portfolio forecast table', () => {
  it('keeps the calculated trend for a product with observed demand', async () => {
    renderPage();

    const row = await waitFor(() => rowFor('Wireless Headphones'));
    expect(within(row).getByText('↑ Increasing')).toBeInTheDocument();
  });

  it('reports a product with no observed demand instead of calling it stable', async () => {
    renderPage();

    const row = await waitFor(() => rowFor('Smart Fitness Band'));
    expect(within(row).getByText('Insufficient sales history')).toBeInTheDocument();
    expect(within(row).queryByText('→ Stable')).toBeNull();
    // The established "stable" wording stays where it is earned.
    expect(within(rowFor('Wireless Headphones')).queryByText('→ Stable')).toBeNull();
  });

  it('still loads the whole portfolio once, with the default scope', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    expect(service.getForecastOverview).toHaveBeenCalledWith(USER, {
      horizon: 30,
      category: null,
    });
  });

  it('keeps the portfolio metrics and chart alongside the table', async () => {
    renderPage();

    expect(await screen.findByText('Forecast Total')).toBeInTheDocument();
    expect(screen.getByText('Next 30 Days — Demand Outlook')).toBeInTheDocument();
    expect(screen.getByTestId('demand-chart')).toBeInTheDocument();
  });

  it('asks for the category scope when a category is chosen', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    service.getForecastOverview.mockClear();
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'Electronics' },
    });

    await waitFor(() =>
      expect(service.getForecastOverview).toHaveBeenCalledWith(USER, {
        horizon: 30,
        category: 'Electronics',
      }),
    );
  });
});

describe('searching for a product on the Forecast page', () => {
  it('finds a product typed in its own case', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('Smart Fitness Band');

    await matchesShown(['Smart Fitness Band']);
    expect(screen.getByText('P006')).toBeInTheDocument();
    expect(screen.queryByText('Desk Lamp Pro')).toBeNull();
  });

  it('finds the same product typed in lower case', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('smart fitness band');

    await matchesShown(['Smart Fitness Band']);
    expect(screen.getByText('1 product matching “smart fitness band”')).toBeInTheDocument();
  });

  it('finds the same product typed in upper case', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('SMART FITNESS BAND');

    await matchesShown(['Smart Fitness Band']);
  });

  it('finds the same product typed in mixed case', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('Smart fitness BAND');

    await matchesShown(['Smart Fitness Band']);
  });

  it('ignores leading and trailing whitespace around the name', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('   smart fitness band   ');

    await matchesShown(['Smart Fitness Band']);
  });

  it('treats a whitespace-only box as no search at all', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('   ');

    // No product is selected, so the portfolio forecast is still what is shown,
    // and the catalog was never read.
    expect(screen.getByText('Forecast by Product')).toBeInTheDocument();
    expect(screen.queryByText('No product found')).toBeNull();
    expect(inventory.listProducts).not.toHaveBeenCalled();
  });

  it('matches on the product id as well as the name', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('p006');

    await matchesShown(['Smart Fitness Band']);
  });

  it('lists every match and chooses none of them when several products match', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('wireless');

    await matchesShown(['Wireless Headphones', 'Wireless Mouse', 'Wireless Charger']);
    expect(screen.getByText('3 products matching “wireless”')).toBeInTheDocument();
    // No product was picked on the reader's behalf, so no forecast was fetched.
    expect(service.getProductForecast).not.toHaveBeenCalled();
  });

  it('shows a clear empty state for a product that does not exist', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('smartwatch');

    expect(await screen.findByText('No product found')).toBeInTheDocument();
    expect(screen.getByText(/no product in your catalog is named/i)).toBeInTheDocument();
    expect(screen.queryByText('Smart Fitness Band')).toBeNull();
  });

  it('drops a previous match rather than leaving its forecast on screen', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('smart fitness band');
    await matchesShown(['Smart Fitness Band']);

    await typeSearch('smartwatch');

    expect(await screen.findByText('No product found')).toBeInTheDocument();
    expect(screen.queryByText('Smart Fitness Band')).toBeNull();
    // No product forecast was ever shown here, so none can go stale.
    expect(screen.queryByText('Forecast status')).toBeNull();
  });

  it('reads the catalog once, and does not re-request the portfolio while typing', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');
    expect(service.getForecastOverview).toHaveBeenCalledTimes(1);

    await typeSearch('sm');
    await typeSearch('smart');
    await typeSearch('smart fitness band');
    await matchesShown(['Smart Fitness Band']);

    expect(service.getForecastOverview).toHaveBeenCalledTimes(1);
    expect(inventory.listProducts).toHaveBeenCalledTimes(1);
  });

  it('reports a catalog that cannot be read, and still offers the way back', async () => {
    inventory.listProducts.mockRejectedValue(new Error('Catalog is unavailable.'));
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('band');

    expect(await screen.findByText('Search unavailable')).toBeInTheDocument();
    expect(screen.getByText('Catalog is unavailable.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /back to all forecasts/i }),
    ).toBeInTheDocument();
  });

  it('restores the portfolio forecast when the reader goes back to all forecasts', async () => {
    renderPage();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('smart fitness band');
    await matchesShown(['Smart Fitness Band']);
    expect(screen.queryByText('Forecast by Product')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /all forecasts/i }));

    expect(await screen.findByText('Forecast by Product')).toBeInTheDocument();
    expect(screen.getByText('Forecast Total')).toBeInTheDocument();
    expect(screen.getByTestId('demand-chart')).toBeInTheDocument();
    expect(searchBox()).toHaveValue('');
  });
});

describe('following a product search to that product’s forecast', () => {
  it('opens the one product the search named, without an id being typed', async () => {
    renderWithRoutes();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('smart fitness band');
    await matchesShown(['Smart Fitness Band']);

    fireEvent.click(screen.getByRole('button', { name: /view forecast/i }));

    expect(
      await screen.findByRole('heading', { name: /Smart Fitness Band/ }),
    ).toBeInTheDocument();
    // The existing product endpoint, asked for the product the search found.
    expect(service.getProductForecast).toHaveBeenCalledTimes(1);
    expect(service.getProductForecast).toHaveBeenCalledWith(USER, 'P006', 30);
  });

  it('keeps a zero-history product reporting no sales history', async () => {
    renderWithRoutes();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('SMART FITNESS BAND ');
    await matchesShown(['Smart Fitness Band']);
    fireEvent.click(screen.getByRole('button', { name: /view forecast/i }));

    expect(await screen.findByText('No sales history')).toBeInTheDocument();
    expect(screen.getByText('Baseline estimate — Cold start')).toBeInTheDocument();
    expect(screen.getByText('0 days')).toBeInTheDocument();
    expect(screen.queryByText('→ Stable')).toBeNull();
  });

  it('keeps a product with real demand showing its real trend, model and days', async () => {
    renderWithRoutes();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('wireless');
    await matchesShown(['Wireless Mouse', 'Wireless Charger', 'Wireless Headphones']);
    // The reader picks the intended product out of several matches.
    fireEvent.click(screen.getByText('Wireless Charger').closest('button'));

    expect(
      await screen.findByRole('heading', { name: /Wireless Charger/ }),
    ).toBeInTheDocument();
    // The existing product endpoint, asked for the product that was picked.
    expect(service.getProductForecast).toHaveBeenCalledWith(USER, 'P008', 30);
    expect(service.getProductForecast).toHaveBeenCalledTimes(1);
    expect(screen.getByText('↑ Increasing')).toBeInTheDocument();
    expect(screen.getByText('Trained demand model (xgboost-v1.0.0)')).toBeInTheDocument();
    expect(screen.getByText('60+ days')).toBeInTheDocument();
  });

  it('brings the portfolio forecast back from the product forecast', async () => {
    renderWithRoutes();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('smart fitness band');
    await matchesShown(['Smart Fitness Band']);
    fireEvent.click(screen.getByRole('button', { name: /view forecast/i }));
    await screen.findByText('No sales history');

    fireEvent.click(screen.getByRole('button', { name: /all forecasts/i }));

    expect(await screen.findByText('Forecast by Product')).toBeInTheDocument();
    expect(screen.getByTestId('demand-chart')).toBeInTheDocument();
    expect(screen.queryByText('Forecast status')).toBeNull();
  });

  it('reports a product forecast that cannot be loaded', async () => {
    service.getProductForecast.mockRejectedValue(
      new Error("'P999' is not in workspace 'tenant-a'."),
    );
    renderWithRoutes();
    await screen.findByText('Smart Fitness Band');

    await typeSearch('desk lamp pro');
    await matchesShown(['Desk Lamp Pro']);
    fireEvent.click(screen.getByRole('button', { name: /view forecast/i }));

    expect(
      await screen.findByText('Product forecast unavailable'),
    ).toBeInTheDocument();
    expect(screen.getByText("'P999' is not in workspace 'tenant-a'.")).toBeInTheDocument();
    expect(screen.queryByText('→ Stable')).toBeNull();
  });
});
