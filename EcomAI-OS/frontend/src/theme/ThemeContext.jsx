import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DARK,
  DEFAULT_THEME,
  LIGHT,
  applyTheme,
  currentTheme,
  isTheme,
  readStoredTheme,
  resolveInitialTheme,
  writeStoredTheme,
} from './theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Used when a component is rendered outside the provider — a chart mounted in
 * isolation, or a test that only cares about one thing. The setters still write
 * the theme onto the document, so nothing is silently inert; there is just no
 * React state to re-render with.
 */
const fallbackTheme = {
  theme: DEFAULT_THEME,
  setTheme: (next) => applyTheme(next),
  toggleTheme: () => applyTheme(currentTheme() === DARK ? LIGHT : DARK),
  hasStoredPreference: false,
};

const ThemeContext = createContext(fallbackTheme);

const safeMatchMedia = (query) =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;

const safeStorage = () => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

export function ThemeProvider({ children, storage, matchMedia, initialTheme }) {
  const store = useMemo(
    () => (storage === undefined ? safeStorage() : storage),
    [storage],
  );
  // Memoised, because window.matchMedia hands back a fresh object each call and
  // an unstable value here would re-subscribe the system listener on every
  // render. `mediaQuery` is the function, `media` the list it returns.
  const mediaQuery = useMemo(
    () => (matchMedia === undefined ? safeMatchMedia : matchMedia),
    [matchMedia],
  );
  const media = useMemo(
    () => (typeof mediaQuery === 'function' ? mediaQuery(DARK_QUERY) : null),
    [mediaQuery],
  );

  const [theme, setTheme] = useState(
    () => initialTheme ?? resolveInitialTheme({ storage: store, matchMedia: mediaQuery }),
  );

  // A stored choice is the user's decision and outranks the system setting. The
  // system listener only runs while there is nothing stored, so following the
  // OS later (e.g. it flips to night mode) updates an untouched app but never
  // overrides someone who has already chosen.
  const hasStoredPreference = isTheme(readStoredTheme(store));

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (hasStoredPreference) return undefined;
    const list = media;
    if (!list?.addEventListener) return undefined;
    const onChange = (event) => setTheme(event.matches ? DARK : LIGHT);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [hasStoredPreference, media]);

  const choose = useCallback(
    (next) => {
      const value = isTheme(next) ? next : DEFAULT_THEME;
      writeStoredTheme(value, store);
      setTheme(value);
    },
    [store],
  );

  const toggle = useCallback(() => {
    setTheme((current) => {
      const value = current === DARK ? LIGHT : DARK;
      writeStoredTheme(value, store);
      return value;
    });
  }, [store]);

  const value = useMemo(
    () => ({ theme, setTheme: choose, toggleTheme: toggle, hasStoredPreference }),
    [theme, choose, toggle, hasStoredPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
