// Theme resolution, kept free of React so it can be reasoned about — and
// tested — on its own.
//
// The rule is deliberately small: a stored choice wins, otherwise the operating
// system decides, otherwise light. The same three lines run twice: once as the
// inline script in index.html (which runs before React, so the first paint is
// already the right theme) and once in ThemeProvider.

export const THEME_STORAGE_KEY = 'ecomai-theme';

export const LIGHT = 'light';
export const DARK = 'dark';
export const THEMES = [LIGHT, DARK];

export const DEFAULT_THEME = LIGHT;

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function isTheme(value) {
  return THEMES.includes(value);
}

/**
 * The saved choice, or null. A stored value that is not a known theme is
 * treated as absent rather than trusted, so a hand-edited or stale entry
 * cannot put the app in a theme it has no styles for.
 */
export function readStoredTheme(storage) {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    // Private-mode Safari and blocked third-party storage both throw here.
    // Falling through to the system preference is the right answer.
    return null;
  }
}

export function writeStoredTheme(theme, storage) {
  try {
    if (isTheme(theme)) storage?.setItem(THEME_STORAGE_KEY, theme);
    else storage?.removeItem(THEME_STORAGE_KEY);
  } catch {
    // A theme that cannot be persisted still applies for this session.
  }
}

/** The operating system's preference, defaulting to light when unknowable. */
export function systemTheme(matchMedia) {
  try {
    return matchMedia?.(DARK_QUERY)?.matches ? DARK : LIGHT;
  } catch {
    return DEFAULT_THEME;
  }
}

export function resolveInitialTheme({ storage, matchMedia } = {}) {
  return readStoredTheme(storage) ?? systemTheme(matchMedia);
}

/**
 * Writes the theme onto the document. One class on <html> is the whole switch:
 * every token in index.css is declared twice, once under `:root` and once
 * under `.dark`, so nothing else has to know which theme is active.
 */
export function applyTheme(theme, root = globalThis.document?.documentElement) {
  if (!root) return;
  const next = isTheme(theme) ? theme : DEFAULT_THEME;
  root.classList.toggle(DARK, next === DARK);
  root.dataset.theme = next;
  // Tells the browser which built-in widget colours (scrollbars, date pickers,
  // autofill) to use, so native controls do not stay light on a dark page.
  root.style.colorScheme = next;
  // Keeps the mobile browser chrome in step with the page.
  root.ownerDocument
    ?.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', next === DARK ? '#090e1a' : '#ffffff');
}

/** The theme currently applied to the document. */
export function currentTheme(root = globalThis.document?.documentElement) {
  return root?.classList.contains(DARK) ? DARK : LIGHT;
}
