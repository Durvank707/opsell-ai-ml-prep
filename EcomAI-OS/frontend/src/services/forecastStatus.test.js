// The rule that keeps a product with no sales history from being labelled
// "Stable": the forecast status is read off the eligibility decision the
// endpoint already returns, and a trend is only shown when there is observed
// demand behind it.

import { describe, expect, it } from 'vitest';
import {
  FORECAST_STATUS,
  forecastExplanation,
  forecastModelLabel,
  forecastStatus,
  forecastWarning,
  historyDays,
  historyIsCapped,
  historyLabel,
  portfolioRowStatus,
} from './forecastStatus';

const COLD_START_DESCRIPTION =
  'No ML forecast is generated because the product does not yet have enough sales history. A baseline estimate is shown instead while history accumulates.';

/** The exact payload the endpoint returns for a product that has never sold. */
function zeroHistoryForecast(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function mlForecast(overrides = {}) {
  return {
    productId: 'P001',
    productName: 'Wireless Headphones',
    category: 'Electronics',
    horizon: 30,
    points: [
      { date: '2026-05-25', forecast: 20, lower: 15, upper: 25 },
      { date: '2026-05-26', forecast: 22, lower: 17, upper: 27 },
    ],
    actuals: Array.from({ length: 60 }, (_, i) => ({ date: `2026-03-${i + 1}`, units: 10 })),
    total: 586.39,
    avgDaily: 19.55,
    peakDate: '2026-05-30',
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
    warning: 'The ML forecast is available, but the history is limited; treat it as a lower-confidence estimate.',
    mlUnavailable: false,
    ...overrides,
  };
}

describe('forecastStatus — a product with no sales history', () => {
  it('is reported as having no sales history, never as stable', () => {
    const status = forecastStatus(zeroHistoryForecast());
    expect(status.code).toBe(FORECAST_STATUS.NO_HISTORY);
    expect(status.label).toBe('No sales history');
  });

  it('keeps the trend out of the UI, because no demand was ever observed', () => {
    expect(zeroHistoryForecast().trend).toBe('stable');
    expect(forecastStatus(zeroHistoryForecast()).trendMeaningful).toBe(false);
  });

  it('reports zero days of history', () => {
    const forecast = zeroHistoryForecast();
    expect(historyDays(forecast)).toBe(0);
    expect(historyLabel(forecast)).toBe('0 days');
    expect(historyIsCapped(forecast)).toBe(false);
  });

  it('names the model that produced the numbers, using the API tier label', () => {
    expect(forecastModelLabel(zeroHistoryForecast())).toBe(
      'Baseline estimate — Cold start',
    );
  });

  it("reuses the gate's own explanation rather than inventing copy", () => {
    expect(forecastExplanation(zeroHistoryForecast())).toBe(
      COLD_START_DESCRIPTION,
    );
  });

  it('does not repeat the explanation as a second warning', () => {
    expect(forecastWarning(zeroHistoryForecast())).toBeNull();
  });
});

describe('forecastStatus — a product with real history', () => {
  it('keeps the calculated trend', () => {
    const status = forecastStatus(mlForecast());
    expect(status.code).toBe(FORECAST_STATUS.LIMITED_HISTORY);
    expect(status.label).toBe('Limited sales history');
    expect(status.trendMeaningful).toBe(true);
  });

  it('says limited history is still a real answer, not a missing one', () => {
    const status = forecastStatus(mlForecast());
    expect(status.code).not.toBe(FORECAST_STATUS.NO_HISTORY);
    expect(status.code).not.toBe(FORECAST_STATUS.UNAVAILABLE);
  });

  it('marks a full-confidence model forecast as available', () => {
    const status = forecastStatus(
      mlForecast({
        eligibility: {
          eligible: true,
          tier: 'preferred_range',
          tier_label: 'Preferred range',
          description: 'The product has 180–364 days of history.',
          confidence_label: 'standard',
        },
        warning: null,
      }),
    );
    expect(status.code).toBe(FORECAST_STATUS.AVAILABLE);
    expect(status.label).toBe('Forecast available');
    expect(status.trendMeaningful).toBe(true);
  });

  it('names the trained model and its version', () => {
    expect(forecastModelLabel(mlForecast())).toBe(
      'Trained demand model (xgboost-v1.0.0)',
    );
  });

  it('surfaces a warning that adds something to the explanation', () => {
    expect(forecastWarning(mlForecast())).toBe(
      'The ML forecast is available, but the history is limited; treat it as a lower-confidence estimate.',
    );
  });

  it('counts history from the actuals the response carries', () => {
    const forecast = mlForecast();
    expect(historyDays(forecast)).toBe(60);
    expect(historyIsCapped(forecast)).toBe(true);
    // The endpoint only returns the trailing 60 days, so the count is "60+".
    expect(historyLabel(forecast)).toBe('60+ days');
  });

  it('shows a partial window as an exact count', () => {
    const forecast = mlForecast({
      actuals: [{ date: '2026-05-01', units: 3 }],
    });
    expect(historyLabel(forecast)).toBe('1 day');
  });
});

describe('forecastStatus — edge cases', () => {
  it('reports a product that has some history but not enough', () => {
    const status = forecastStatus(
      zeroHistoryForecast({
        actuals: Array.from({ length: 12 }, (_, i) => ({ date: `2026-05-${i + 1}`, units: 2 })),
        points: [{ date: '2026-05-25', forecast: 2, lower: 1, upper: 3 }],
        total: 2,
      }),
    );
    expect(status.code).toBe(FORECAST_STATUS.INSUFFICIENT_HISTORY);
    expect(status.label).toBe('Insufficient sales history');
    expect(status.trendMeaningful).toBe(false);
  });

  it('reports an ML failure as a baseline over real history, so the trend stands', () => {
    // Enough history that the tier is not itself the caveat, so what the reader
    // needs to know is that the model did not run.
    const failed = mlForecast({
      fallbackUsed: 'baseline',
      modelVersion: null,
      mlUnavailable: true,
      eligibility: {
        eligible: true,
        tier: 'preferred_range',
        tier_label: 'Preferred range',
        description: 'The product has 180–364 days of history.',
        confidence_label: 'standard',
      },
    });
    const status = forecastStatus(failed);
    expect(status.code).toBe(FORECAST_STATUS.BASELINE_FALLBACK);
    expect(status.trendMeaningful).toBe(true);
    expect(forecastModelLabel(failed)).toBe('Baseline estimate — Preferred range');
  });

  it('keeps the history caveat when a limited-history model also failed', () => {
    const status = forecastStatus(
      mlForecast({ fallbackUsed: 'baseline', modelVersion: null, mlUnavailable: true }),
    );
    expect(status.code).toBe(FORECAST_STATUS.LIMITED_HISTORY);
    expect(status.trendMeaningful).toBe(true);
  });

  it('handles a missing forecast without claiming anything about history', () => {
    const status = forecastStatus(null);
    expect(status.code).toBe(FORECAST_STATUS.UNAVAILABLE);
    expect(status.label).toBe('Forecast unavailable');
    expect(status.trendMeaningful).toBe(false);
    expect(historyLabel(null)).toBe('—');
    expect(forecastModelLabel(null)).toBeNull();
    expect(forecastExplanation(null)).toBeNull();
    expect(forecastWarning(null)).toBeNull();
  });

  it('does not invent a model label when the response carries none', () => {
    expect(forecastModelLabel({ actuals: [] })).toBeNull();
  });
});

describe('portfolioRowStatus — the forecast table row', () => {
  it('reports a product averaging zero demand as having insufficient history', () => {
    const status = portfolioRowStatus({ id: 'P006', current: 0, trend: 'stable' });
    expect(status.code).toBe(FORECAST_STATUS.INSUFFICIENT_HISTORY);
    expect(status.trendMeaningful).toBe(false);
  });

  it('keeps the trend for a product with observed demand', () => {
    const status = portfolioRowStatus({ id: 'P001', current: 19.5, trend: 'increasing' });
    expect(status.code).toBe(FORECAST_STATUS.AVAILABLE);
    expect(status.trendMeaningful).toBe(true);
  });

  it('marks a baseline row that does have demand', () => {
    const status = portfolioRowStatus({
      id: 'P001',
      current: 4.2,
      trend: 'decreasing',
      fallbackUsed: 'baseline',
    });
    expect(status.code).toBe(FORECAST_STATUS.BASELINE_FALLBACK);
    expect(status.trendMeaningful).toBe(true);
  });

  it('handles a missing row', () => {
    expect(portfolioRowStatus(null).code).toBe(FORECAST_STATUS.UNAVAILABLE);
  });
});
