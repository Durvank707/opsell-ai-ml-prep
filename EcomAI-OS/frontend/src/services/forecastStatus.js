// How far a product forecast can be trusted, in the words the API already uses.
//
// The product forecast endpoint answers this itself: every response carries the
// eligibility decision (`tier`, `tier_label`, `description`, `confidence_label`)
// and a composed `warning` next to the numbers, including for a product that
// has never sold a unit. This module only reads those fields and picks the
// wording to show, so the "can this trend be believed?" rule lives in one place
// and the forecast math itself stays where it is.
//
// The rule that matters: `trend` is a comparison of observed demand windows, so
// with no observed demand it is not evidence of anything. The API answers
// "stable" there because an empty series has no movement to report, which used
// to reach the UI as a green "Stable" badge on a brand-new product. Here that
// case is reported as missing history instead, and the trend is simply not shown.

/** The product forecast only ever carries the most recent 60 days of actuals. */
export const ACTUALS_WINDOW = 60;

export const FORECAST_STATUS = {
  NO_HISTORY: 'no_history',
  INSUFFICIENT_HISTORY: 'insufficient_history',
  LIMITED_HISTORY: 'limited_history',
  BASELINE_FALLBACK: 'baseline_fallback',
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
};

const LABELS = {
  [FORECAST_STATUS.NO_HISTORY]: 'No sales history',
  [FORECAST_STATUS.INSUFFICIENT_HISTORY]: 'Insufficient sales history',
  [FORECAST_STATUS.LIMITED_HISTORY]: 'Limited sales history',
  [FORECAST_STATUS.BASELINE_FALLBACK]: 'Baseline estimate',
  [FORECAST_STATUS.AVAILABLE]: 'Forecast available',
  [FORECAST_STATUS.UNAVAILABLE]: 'Forecast unavailable',
};

// Amber while there is nothing solid to stand on, green only for a real answer.
const TONES = {
  [FORECAST_STATUS.NO_HISTORY]: 'amber',
  [FORECAST_STATUS.INSUFFICIENT_HISTORY]: 'amber',
  [FORECAST_STATUS.LIMITED_HISTORY]: 'blue',
  [FORECAST_STATUS.BASELINE_FALLBACK]: 'blue',
  [FORECAST_STATUS.AVAILABLE]: 'green',
  [FORECAST_STATUS.UNAVAILABLE]: 'neutral',
};

// A trend is only worth showing once there is observed demand behind it.
const TREND_MEANINGFUL = new Set([
  FORECAST_STATUS.LIMITED_HISTORY,
  FORECAST_STATUS.BASELINE_FALLBACK,
  FORECAST_STATUS.AVAILABLE,
]);

/** Days of recorded demand the response carries. */
export function historyDays(forecast) {
  return forecast?.actuals?.length ?? 0;
}

/** True when the response shows only the trailing window, so the true count is higher. */
export function historyIsCapped(forecast) {
  return historyDays(forecast) >= ACTUALS_WINDOW;
}

/** "0 days" / "12 days" / "60+ days" — never a precise number we cannot stand behind. */
export function historyLabel(forecast) {
  if (!forecast) return '—';
  const days = historyDays(forecast);
  if (days === 0) return '0 days';
  if (historyIsCapped(forecast)) return `${ACTUALS_WINDOW}+ days`;
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** Status, label, badge tone and whether a trend means anything for this forecast. */
export function forecastStatus(forecast) {
  return statusFor(forecast ? statusCode(forecast) : FORECAST_STATUS.UNAVAILABLE);
}

/**
 * The same judgement for a portfolio table row, which reports a product's
 * average daily demand instead of its actuals series. A row averaging zero has
 * no observed demand behind it, so its trend is not evidence of anything either
 * — the eligibility decision is not in a portfolio response, and one request per
 * row is not worth a "Stable" that was never calculated.
 */
export function portfolioRowStatus(row) {
  if (!row) return statusFor(FORECAST_STATUS.UNAVAILABLE);
  if (!(Number(row.current) > 0)) return statusFor(FORECAST_STATUS.INSUFFICIENT_HISTORY);
  if (row.fallbackUsed === 'baseline') return statusFor(FORECAST_STATUS.BASELINE_FALLBACK);
  return statusFor(FORECAST_STATUS.AVAILABLE);
}

function statusFor(code) {
  return {
    code,
    label: LABELS[code],
    tone: TONES[code],
    trendMeaningful: TREND_MEANINGFUL.has(code),
  };
}

function statusCode(forecast) {
  // No recorded days is the case that used to read as "Stable". The tier label
  // the API sends for it is "Cold start", which covers a product with a handful
  // of days too, so the day count is what separates the two.
  if (historyDays(forecast) === 0) return FORECAST_STATUS.NO_HISTORY;
  const confidence = forecast.eligibility?.confidence_label;
  if (confidence === 'insufficient_history') return FORECAST_STATUS.INSUFFICIENT_HISTORY;
  if (confidence === 'limited') return FORECAST_STATUS.LIMITED_HISTORY;
  // A baseline stands in for the model: either the model failed for this
  // product, or the response is a baseline projection to begin with. History is
  // real here, so the status is not an amber "cannot be trusted".
  if (forecast.mlUnavailable || forecast.fallbackUsed === 'baseline') {
    return FORECAST_STATUS.BASELINE_FALLBACK;
  }
  return FORECAST_STATUS.AVAILABLE;
}

/**
 * The model behind the numbers, in the API's own vocabulary: the trained model
 * and its version, or a baseline estimate carrying the eligibility tier label.
 * `null` when the response says neither (the demo data source labels nothing).
 */
export function forecastModelLabel(forecast) {
  if (!forecast) return null;
  const tierLabel = forecast.eligibility?.tier_label;
  if (forecast.fallbackUsed === 'ml') {
    return forecast.modelVersion
      ? `Trained demand model (${forecast.modelVersion})`
      : 'Trained demand model';
  }
  if (forecast.fallbackUsed === 'baseline') {
    return tierLabel ? `Baseline estimate — ${tierLabel}` : 'Baseline estimate';
  }
  return null;
}

/** Why the forecast looks the way it does, in the eligibility gate's own words. */
export function forecastExplanation(forecast) {
  return forecast?.eligibility?.description || forecast?.warning || null;
}

/**
 * The warning, but only when it says something the explanation does not. For a
 * product the gate refused, `warning` is the tier description plus the gate
 * reasons, so showing both would say the same thing twice.
 */
export function forecastWarning(forecast) {
  if (!forecast) return null;
  const warning = typeof forecast.warning === 'string' ? forecast.warning.trim() : '';
  if (!warning) return null;
  const explanation = forecastExplanation(forecast);
  if (explanation && warning.includes(explanation)) return null;
  return warning;
}
