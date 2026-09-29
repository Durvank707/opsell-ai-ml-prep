// The portfolio/category forecast table, and how it reports a product that has
// never sold.
//
// A row in this table reports a product's average daily demand but not its
// eligibility decision, so a new product arrived here looking identical to a
// settled one: zero average, zero forecast, and a "Stable" trend that was never
// calculated from demand. The row now says the history is missing, and every
// product that does have observed demand keeps its trend.

import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

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
}));
vi.mock('../services/forecastService', () => service);

vi.mock('../components/charts', () => ({
  DemandChart: () => <div data-testid="demand-chart" />,
}));

const { default: ForecastPage } = await import('./ForecastPage');

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

beforeEach(() => {
  service.getForecastOverview.mockReset();
  service.generatePortfolioForecast.mockReset();
  service.getForecastOverview.mockResolvedValue(OVERVIEW);
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
    const { fireEvent } = await import('@testing-library/react');
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
