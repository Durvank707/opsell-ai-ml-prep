// The individual product forecast page, and the way into it from a product.
//
// The forecast numbers come from the existing product forecast endpoint; what
// this page is responsible for is telling the reader what those numbers are
// worth. A product with no sales history must say "No sales history" and must
// not show a "Stable" trend badge, because there is no observed demand for a
// trend to have been calculated from. A product with real history keeps its
// status, its trend and its day-by-day forecast.

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

const forecasts = vi.hoisted(() => ({ getProductForecast: vi.fn() }));
vi.mock('../services/forecastService', () => forecasts);

const inventory = vi.hoisted(() => ({
  getProduct: vi.fn(),
  getInventoryTimeline: vi.fn(),
}));
vi.mock('../services/inventoryService', () => inventory);

vi.mock('../services/settingsService', () => ({
  placeSimulatedOrder: vi.fn(),
}));

// The charts pull in a plotting library; the page's contract is the data it
// hands them, so they are replaced with markers that expose what they got.
vi.mock('../components/charts', () => ({
  DemandChart: ({ actuals, forecast, footer }) => (
    <div data-testid="demand-chart">
      <span data-testid="chart-actuals">{actuals.length}</span>
      <span data-testid="chart-forecast">{forecast.length}</span>
      {footer}
    </div>
  ),
  StockLineChart: () => <div data-testid="stock-chart" />,
}));

const { default: ProductForecastPage } = await import('./ProductForecastPage');
const { default: ProductDetailPage } = await import('./ProductDetailPage');

const COLD_START_DESCRIPTION =
  'No ML forecast is generated because the product does not yet have enough sales history. A baseline estimate is shown instead while history accumulates.';

/** What the endpoint returns for a product that has never sold a unit. */
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
  warning:
    'The ML forecast is available, but the history is limited; treat it as a lower-confidence estimate.',
  mlUnavailable: false,
};

const P001_PRODUCT = {
  id: 'P001',
  name: 'Wireless Headphones',
  category: 'Electronics',
  currentStock: 225,
  minStock: 60,
  openOrderQty: 0,
  expectedArrival: null,
  leadTimeDays: 4,
  supplier: 'Acme Audio',
  unitCost: 1000,
  sellingPrice: 1999,
  dailyAvg: 19.5,
  sigma: 7.8,
  safetyStock: 20,
  reorderPoint: 98,
  targetStock: 200,
  status: 'healthy',
  stockoutRisk: false,
  inventoryPosition: 225,
  daysOfInventory: 11.5,
  recommendedOrderQty: 0,
  leadTimeDemand: 78,
  projectedDemandDuringLeadTime: 78,
  trend: { trend: 'increasing', growthPct: 8.5 },
  forecast30: 586,
  forecast30AvgDaily: 19.5,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** Render the product forecast page at its own route, as the router does. */
function renderForecast(productId = 'P006') {
  return render(
    <MemoryRouter initialEntries={[`/app/products/${productId}/forecast`]}>
      <Routes>
        <Route
          path="/app/products/:productId/forecast"
          element={<ProductForecastPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  forecasts.getProductForecast.mockReset();
  inventory.getProduct.mockReset();
  inventory.getInventoryTimeline.mockReset();
  inventory.getInventoryTimeline.mockResolvedValue({
    points: [],
    reorderPoint: 98,
    expectedDepletion: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the individual product forecast', () => {
  it('shows a normal product: status, model, history, trend and the day-by-day forecast', async () => {
    forecasts.getProductForecast.mockResolvedValue(P001_FORECAST);

    renderForecast('P001');

    expect(
      await screen.findByRole('heading', { name: /Wireless Headphones/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('P001')).toBeInTheDocument();
    expect(screen.getByText('Limited sales history')).toBeInTheDocument();
    expect(screen.getByText('Trained demand model (xgboost-v1.0.0)')).toBeInTheDocument();
    expect(screen.getByText('60+ days')).toBeInTheDocument();
    // A trend of increasing demand is real information here.
    expect(screen.getByText('↑ Increasing')).toBeInTheDocument();
    expect(screen.queryByText(/no demand history to compare/i)).toBeNull();
    // The numbers the reader came for.
    expect(screen.getByText('586 units')).toBeInTheDocument();
    expect(screen.getByText('20 units')).toBeInTheDocument();
    // All 30 days are listed, each with its likely range.
    expect(screen.getByText('Day 1')).toBeInTheDocument();
    expect(screen.getByText('Day 30')).toBeInTheDocument();
    expect(screen.getAllByText(/^Day \d+$/)).toHaveLength(30);
    expect(screen.getAllByText('12 – 24').length).toBeGreaterThan(0);
    expect(screen.getByTestId('chart-actuals')).toHaveTextContent('60');
    expect(screen.getByTestId('chart-forecast')).toHaveTextContent('30');
  });

  it('tells a product with no sales history so, instead of showing it as stable', async () => {
    forecasts.getProductForecast.mockResolvedValue(P006_FORECAST);

    renderForecast('P006');

    expect(await screen.findByText('No sales history')).toBeInTheDocument();
    expect(screen.getByText('Smart Fitness Band')).toBeInTheDocument();
    expect(screen.getByText('Baseline estimate — Cold start')).toBeInTheDocument();
    expect(screen.getByText('0 days')).toBeInTheDocument();
    // The misleading badge is gone, and the reason is given in the gate's words.
    expect(screen.queryByText('→ Stable')).toBeNull();
    expect(
      screen.getByText(/no demand history to compare/i),
    ).toBeInTheDocument();
    // The gate's own sentence explains it, once.
    expect(screen.getAllByText(
      /no ML forecast is generated because the product does not yet have enough sales history/i,
    )).toHaveLength(1);
    // Nothing is charted, and the reader is told why rather than shown an empty axis.
    expect(screen.getByText('No demand forecast to show')).toBeInTheDocument();
    expect(screen.queryByTestId('demand-chart')).toBeNull();
    expect(screen.queryByText('Day 1')).toBeNull();
  });

  it('keeps the explanation to one sentence for a refused product', async () => {
    forecasts.getProductForecast.mockResolvedValue(P006_FORECAST);

    renderForecast('P006');
    await screen.findByText('No sales history');

    // The explanation appears once (in the explanation callout). The warning
    // that repeats the same sentence is suppressed so the UI does not read
    // it twice.
    const explanations = screen.getAllByText(
      /no ml forecast is generated because the product does not yet have enough sales history/i,
    );
    expect(explanations).toHaveLength(1);  });

  it('shows a partial history as insufficient, without a trend or a forecast total', async () => {
    forecasts.getProductForecast.mockResolvedValue({
      ...P006_FORECAST,
      actuals: Array.from({ length: 12 }, (_, i) => ({
        date: `2026-09-${String(i + 1).padStart(2, '0')}`,
        units: 2,
      })),
      eligibility: {
        ...P006_FORECAST.eligibility,
        tier: 'cold_start',
        tier_label: 'Cold start',
      },
    });

    renderForecast('P006');

    expect(await screen.findByText('Insufficient sales history')).toBeInTheDocument();
    expect(screen.getByText('12 days')).toBeInTheDocument();
    expect(screen.queryByText('→ Stable')).toBeNull();
    expect(screen.getByText('No demand forecast to show')).toBeInTheDocument();
  });

  it('surfaces a limited-confidence warning that adds to the explanation', async () => {
    forecasts.getProductForecast.mockResolvedValue(P001_FORECAST);

    renderForecast('P001');

    expect(
      await screen.findByText(
        'The ML forecast is available, but the history is limited; treat it as a lower-confidence estimate.',
      ),
    ).toBeInTheDocument();
  });

  it('asks for the product forecast exactly once, so it does not double the work of the dashboard', async () => {
    forecasts.getProductForecast.mockResolvedValue(P001_FORECAST);

    renderForecast('P001');
    await screen.findByRole('heading', { name: /Wireless Headphones/ });

    expect(forecasts.getProductForecast).toHaveBeenCalledTimes(1);
    expect(forecasts.getProductForecast).toHaveBeenCalledWith(USER, 'P001', 30);
  });

  it('reports an unknown product or a failed request without pretending to have a forecast', async () => {
    forecasts.getProductForecast.mockRejectedValue(
      new Error("'P999' is not in workspace 'tenant-a'."),
    );

    renderForecast('P999');

    expect(
      await screen.findByText('Product forecast unavailable'),
    ).toBeInTheDocument();
    expect(screen.getByText("'P999' is not in workspace 'tenant-a'.")).toBeInTheDocument();
    expect(screen.queryByText('→ Stable')).toBeNull();
    expect(screen.queryByTestId('demand-chart')).toBeNull();
  });

  it('falls back to a generic sentence when the failure carries no message', async () => {
    forecasts.getProductForecast.mockRejectedValue({});

    renderForecast('P001');

    expect(await screen.findByText('Product forecast unavailable')).toBeInTheDocument();
    expect(
      screen.getByText(/could not be loaded/i),
    ).toBeInTheDocument();
  });
});

describe('getting to a product forecast from the product', () => {
  it('opens the forecast for that product from the product details page', async () => {
    inventory.getProduct.mockResolvedValue(P001_PRODUCT);
    forecasts.getProductForecast.mockImplementation((_user, productId) =>
      productId === 'P001'
        ? Promise.resolve(P001_FORECAST)
        : Promise.reject(new Error('unknown')),
    );

    render(
      <MemoryRouter initialEntries={['/app/products/P001']}>
        <Routes>
          <Route path="/app/products/:productId" element={<ProductDetailPage />} />
          <Route
            path="/app/products/:productId/forecast"
            element={<ProductForecastPage />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const action = await screen.findByRole('button', { name: /view forecast/i });
    fireEvent.click(action);

    // The route resolves and the individual forecast is on screen, with no
    // product id typed in by hand.
    expect(
      await screen.findByRole('heading', { name: /Wireless Headphones/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Limited sales history')).toBeInTheDocument();
    expect(screen.getByText('Day 1')).toBeInTheDocument();
  });

  it('does not label a new product stable on its details page', async () => {
    inventory.getProduct.mockResolvedValue({
      ...P001_PRODUCT,
      id: 'P006',
      name: 'Smart Fitness Band',
      category: 'Wearables',
      forecast30: 0,
      trend: { trend: 'stable', growthPct: 0 },
    });
    forecasts.getProductForecast.mockResolvedValue(P006_FORECAST);

    render(
      <MemoryRouter initialEntries={['/app/products/P006']}>
        <Routes>
          <Route path="/app/products/:productId" element={<ProductDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: /Smart Fitness Band/ });
    await waitFor(() =>
      expect(screen.getByText('No sales history')).toBeInTheDocument(),
    );
    expect(screen.queryByText('→ Stable')).toBeNull();
    // The demand card withholds a confident "0" total and says so.
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /view forecast/i })).toBeInTheDocument();
  });

  it('keeps the trend on the details page for a product with real demand', async () => {
    inventory.getProduct.mockResolvedValue(P001_PRODUCT);
    forecasts.getProductForecast.mockResolvedValue(P001_FORECAST);

    render(
      <MemoryRouter initialEntries={['/app/products/P001']}>
        <Routes>
          <Route path="/app/products/:productId" element={<ProductDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const card = await screen.findByRole('heading', {
      name: /Demand — Historical vs Forecast/,
    });
    const footer = within(card.closest('.card'));
    expect(await footer.findByText('↑ Increasing')).toBeInTheDocument();
    expect(footer.getByText('586 units')).toBeInTheDocument();
  });
});
