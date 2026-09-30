/** @type {import('tailwindcss').Config} */

// ---------------------------------------------------------------------------
// Dark mode is a palette swap, not a second set of component styles.
//
// Every colour the app uses lives in src/index.css as a CSS custom property,
// declared once for `:root` and once for `.dark`. This file only maps
// Tailwind's utility names onto those properties, so a component writes
// `bg-white` / `text-slate-600` / `border-rose-200` exactly as before and gets
// the right value in whichever theme is active — no `dark:` variants, no
// per-component overrides.
//
// `<alpha-value>` is what lets Tailwind keep compositing its own opacity
// modifiers (`bg-rose-50/60`) on top of a themed colour.
// ---------------------------------------------------------------------------

/** Wraps a custom property so Tailwind can still apply its own opacity. */
const themed = (property) => `rgb(var(${property}) / <alpha-value>)`;

/** Theme-token references become `rgb(var(…) / <alpha-value>)`; literals pass through. */
const colorValue = (value) => (value.startsWith('--') ? themed(value) : value);

const asColors = (shades = {}) =>
  Object.fromEntries(Object.entries(shades).map(([shade, value]) => [shade, colorValue(value)]));

const SLATE_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/**
 * The neutral ramp is identical for every colour property: `slate-50` is
 * always the page background and `slate-900` always the strongest text, which
 * is what lets the dark theme invert the ramp in CSS alone.
 */
const slateRamp = () => asColors(Object.fromEntries(SLATE_SHADES.map((s) => [s, `--slate-${s}`])));

/**
 * Semantic families (brand and the status hues) cannot use a single ramp the
 * way the neutrals do, because the same shade number plays two jobs:
 * `bg-rose-500` is a filled badge under white text, while `text-rose-500` is a
 * readable foreground. Saturated fills are theme-invariant so they keep one
 * value in both themes; surfaces, borders and foregrounds carry the theme.
 *
 * Every shade the app uses for a family is listed, so a class that exists
 * today cannot silently stop being generated.
 */
const FAMILIES = {
  brand: {
    surface: { 50: '--brand-surface', 100: '--brand-surface-2' },
    line: { 100: '--brand-line-100', 200: '--brand-line-200' },
    lineStrong: { 300: '--brand-line-300', 400: '--brand-line-400' },
    solid: { 500: '--brand-solid-500', 600: '--brand-solid-600', 700: '--brand-solid-700' },
    text: {
      500: '--brand-text-500',
      600: '--brand-text-600',
      700: '--brand-text-700',
      // 100 and 400 are deliberately literal: they are only ever used on top of
      // the brand gradient, where the foreground has to stay light in either
      // theme.
      100: '#e0e7ff',
      400: '#818cf8',
    },
  },
  rose: {
    surface: { 50: '--rose-surface', 100: '--rose-surface-2' },
    line: { 100: '--rose-line', 200: '--rose-line' },
    lineStrong: { 300: '--rose-line', 400: '--rose-line' },
    solid: { 500: '--rose-solid-500', 600: '--rose-solid-600', 700: '--rose-solid-700' },
    text: {
      400: '--rose-text-400',
      500: '--rose-text-500',
      600: '--rose-text-600',
      700: '--rose-text-700',
    },
  },
  emerald: {
    surface: { 50: '--emerald-surface', 100: '--emerald-surface-2' },
    line: { 100: '--emerald-line', 200: '--emerald-line' },
    lineStrong: { 300: '--emerald-line', 400: '--emerald-line' },
    solid: { 500: '--emerald-solid-500', 600: '--emerald-solid-600' },
    text: {
      600: '--emerald-text-600',
      700: '--emerald-text-700',
      800: '--emerald-text-800',
      900: '--emerald-text-900',
    },
  },
  amber: {
    surface: { 50: '--amber-surface', 100: '--amber-surface-2' },
    line: { 100: '--amber-line-100', 200: '--amber-line-200' },
    lineStrong: { 300: '--amber-line-200', 400: '--amber-line-200' },
    solid: { 500: '--amber-solid-500' },
    text: {
      500: '--amber-text-500',
      600: '--amber-text-600',
      700: '--amber-text-700',
      800: '--amber-text-800',
      900: '--amber-text-900',
    },
  },
  sky: {
    surface: { 50: '--sky-surface', 100: '--sky-surface-2' },
    line: { 100: '--sky-line', 200: '--sky-line' },
    lineStrong: { 300: '--sky-line', 400: '--sky-line' },
    solid: { 500: '--sky-solid-500', 600: '--sky-solid-600' },
    text: { 600: '--sky-text-600', 700: '--sky-text-700' },
  },
  indigo: {
    surface: { 50: '--indigo-surface' },
    line: { 100: '--indigo-line', 200: '--indigo-line' },
    lineStrong: { 300: '--indigo-line', 400: '--indigo-line' },
    solid: { 600: '#4f46e5' },
    text: { 600: '--indigo-text-600' },
  },
  // Violet and cyan appear only in the Sales Data callouts. They are mapped
  // like every other family rather than left on Tailwind's defaults, which are
  // light-mode colours: `bg-violet-50/50` would otherwise paint a near-white
  // panel in the dark theme.
  violet: {
    surface: { 50: '--violet-surface', 100: '--violet-surface-2' },
    line: { 100: '--violet-line', 200: '--violet-line' },
    lineStrong: { 300: '--violet-line', 400: '--violet-line' },
    solid: { 600: '--violet-solid-600' },
    text: {
      500: '--violet-text-500',
      600: '--violet-text-600',
      700: '--violet-text-700',
      800: '--violet-text-800',
    },
  },
  cyan: {
    surface: { 50: '--cyan-surface', 100: '--cyan-surface-2' },
    line: { 100: '--cyan-line', 200: '--cyan-line' },
    lineStrong: { 300: '--cyan-line', 400: '--cyan-line' },
    text: { 700: '--cyan-text-700' },
  },
};

const pick = (...groups) => Object.assign({}, ...groups.map(asColors));

// A border that outlines the fill it sits on (the selected tab pill) is not
// tinted, so the solid group joins the line group for borders.
const backgrounds = { white: themed('--surface') };
const textColors = { white: '#ffffff' };
const borders = { white: '#ffffff' };
const rings = { white: '#ffffff' };
const stops = {};

for (const [name, family] of Object.entries(FAMILIES)) {
  backgrounds[name] = pick(family.surface, family.solid);
  textColors[name] = asColors(family.text);
  borders[name] = pick(family.line, family.lineStrong, family.solid);
  rings[name] = pick(family.line, family.lineStrong, family.text, family.solid);
  // Gradient stops are fills, so they take the saturated values.
  stops[name] = asColors(family.solid);
}

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Plus Jakarta Sans',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      // Split per property on purpose — see the note above FAMILIES. `white`
      // is split too: `bg-white` is a surface and follows the theme, while
      // `text-white` and `ring-white` sit on a saturated fill and stay literal.
      backgroundColor: ({ theme }) => ({ ...theme('colors'), ...backgrounds, slate: slateRamp() }),
      textColor: ({ theme }) => ({ ...theme('colors'), ...textColors, slate: slateRamp() }),
      borderColor: ({ theme }) => ({ ...theme('colors'), ...borders, slate: slateRamp() }),
      ringColor: ({ theme }) => ({ ...theme('colors'), ...rings, slate: slateRamp() }),
      // Deliberately no `<alpha-value>`: Tailwind copies this value into
      // preflight verbatim instead of substituting the placeholder, which would
      // leave a literal `<alpha-value>` in the stylesheet and drop the focus
      // ring's offset colour. No `ring-offset-*/opacity` class is used.
      ringOffsetColor: { DEFAULT: 'rgb(var(--surface))' },
      divideColor: ({ theme }) => ({ ...theme('borderColor') }),
      placeholderColor: ({ theme }) => ({ ...theme('textColor') }),
      gradientColorStops: ({ theme }) => ({ ...theme('colors'), ...stops, slate: slateRamp() }),
      boxShadow: {
        soft: 'var(--shadow-soft)',
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-up': 'slide-up 0.25s ease-out',
        'slide-in-right': 'slide-in-right 0.25s ease-out',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
