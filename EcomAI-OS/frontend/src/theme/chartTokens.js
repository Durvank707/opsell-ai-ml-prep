import { useMemo } from 'react';
import { useTheme } from './ThemeContext';
import { DEFAULT_THEME } from './theme';

// ---------------------------------------------------------------------------
// Chart colours live here rather than in index.css because they are handed to
// recharts as SVG `stroke` / `fill` attributes. CSS custom properties are not
// allowed in a presentation attribute, so these have to be real colour strings —
// which means the single place that knows them is this module, not a dozen
// components.
//
// The light values are the colours the app has always used, unchanged. The dark
// values are the same hues re-picked against a dark surface: data lines are
// lightened so they separate from the background, grid lines and axis text are
// muted so they stay behind the data, and the saturated fills that carry meaning
// (a stockout, a reorder point) get brighter rather than darker, because a
// warning that dims into the background stops warning.
// ---------------------------------------------------------------------------

export const CHART_TOKENS = {
  light: {
    axis: '#64748b', //  axis and legend text
    grid: '#e2e8f0', //  grid lines and axis rules
    actual: '#334155', //  observed demand / stock
    forecast: '#4f46e5', //  forecast and inventory line
    band: '#818cf8', //  confidence band, drawn at low opacity
    lost: '#f43f5e', //  demand that could not be met
    reorder: '#f59e0b', //  reorder point rule
    reorderLabel: '#b45309', //  its inline label
    healthy: '#10b981',
    risk: '#f59e0b',
    critical: '#f43f5e',
    bar: '#4f46e5', //  default bar fill
  },
  dark: {
    axis: '#8fa0b5',
    grid: '#27334a',
    actual: '#a9b8ca',
    forecast: '#818cf8',
    band: '#6366f1',
    lost: '#fb7185',
    reorder: '#fbbf24',
    reorderLabel: '#fcd34d',
    healthy: '#34d399',
    risk: '#fbbf24',
    critical: '#fb7185',
    bar: '#6366f1',
  },
};

export function chartTokens(theme) {
  return CHART_TOKENS[theme] || CHART_TOKENS[DEFAULT_THEME];
}

/** Chart colours for the active theme. Re-resolves when the theme flips. */
export function useChartTokens() {
  const { theme } = useTheme();
  return useMemo(() => chartTokens(theme), [theme]);
}
