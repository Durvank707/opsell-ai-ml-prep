// Theme resolution, before React is involved.
//
// The whole feature rests on three rules — a stored choice wins, otherwise the
// operating system decides, otherwise light — plus one switch: a single class on
// <html>. These tests pin that logic directly, because it also runs a second
// time as the inline script in index.html, where a bug would show up as a flash
// of the wrong theme rather than as a failing test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DARK,
  DEFAULT_THEME,
  LIGHT,
  THEME_STORAGE_KEY,
  applyTheme,
  currentTheme,
  isTheme,
  readStoredTheme,
  resolveInitialTheme,
  systemTheme,
  writeStoredTheme,
} from './theme';

/** A stand-in for localStorage that records what was written. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    get size() {
      return map.size;
    },
  };
}

/** A stand-in for window.matchMedia. */
const prefersDark = (matches) => () => ({ matches, addEventListener() {}, removeEventListener() {} });

beforeEach(() => {
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    const el = document.createElement('meta');
    el.setAttribute('name', 'theme-color');
    document.head.appendChild(el);
  }
});

afterEach(() => {
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
});

describe('the saved preference', () => {
  it('is kept under a single, non-sensitive key', () => {
    expect(THEME_STORAGE_KEY).toBe('ecomai-theme');
  });

  it('reads back a theme that was written', () => {
    const storage = memoryStorage();
    writeStoredTheme(DARK, storage);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readStoredTheme(storage)).toBe(DARK);
  });

  it('is treated as absent when nothing has been saved', () => {
    expect(readStoredTheme(memoryStorage())).toBeNull();
  });

  it('is ignored when it holds something that is not a theme', () => {
    // A stale or hand-edited entry must not be able to select a theme the app
    // has no styles for.
    expect(readStoredTheme(memoryStorage({ 'ecomai-theme': 'sepia' }))).toBeNull();
    expect(readStoredTheme(memoryStorage({ 'ecomai-theme': '' }))).toBeNull();
    expect(readStoredTheme(memoryStorage({ 'ecomai-theme': 'true' }))).toBeNull();
  });

  it('survives storage being unavailable, rather than throwing', () => {
    const blocked = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(readStoredTheme(blocked)).toBeNull();
    expect(() => writeStoredTheme(DARK, blocked)).not.toThrow();
  });

  it('only recognises the two themes the app ships', () => {
    expect(isTheme('light')).toBe(true);
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('Dark')).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });
});

describe('picking a theme on a first visit', () => {
  it('follows the system when it asks for dark', () => {
    expect(resolveInitialTheme({ storage: memoryStorage(), matchMedia: prefersDark(true) })).toBe(DARK);
  });

  it('follows the system when it asks for light', () => {
    expect(resolveInitialTheme({ storage: memoryStorage(), matchMedia: prefersDark(false) })).toBe(LIGHT);
  });

  it('falls back to light when the system cannot be asked', () => {
    expect(resolveInitialTheme({ storage: null, matchMedia: null })).toBe(DEFAULT_THEME);
    expect(systemTheme(undefined)).toBe(LIGHT);
    expect(DEFAULT_THEME).toBe(LIGHT);
  });

  it('prefers a saved choice over the system preference', () => {
    // The system asking for dark must not undo a deliberate choice of light.
    const storage = memoryStorage({ 'ecomai-theme': 'light' });
    expect(resolveInitialTheme({ storage, matchMedia: prefersDark(true) })).toBe(LIGHT);
  });

  it('prefers a saved choice of dark over a light system', () => {
    const storage = memoryStorage({ 'ecomai-theme': 'dark' });
    expect(resolveInitialTheme({ storage, matchMedia: prefersDark(false) })).toBe(DARK);
  });
});

describe('applying a theme to the document', () => {
  it('switches the dark theme with one class on <html>', () => {
    applyTheme(DARK);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');

    applyTheme(LIGHT);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('tells the browser which built-in widget colours to use', () => {
    // Date inputs, scrollbars and autofill are drawn by the browser and would
    // otherwise stay light on a dark page.
    applyTheme(DARK);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    applyTheme(LIGHT);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('keeps the mobile browser chrome in step with the page', () => {
    applyTheme(DARK);
    expect(document.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe('#090e1a');
    applyTheme(LIGHT);
    expect(document.querySelector('meta[name="theme-color"]').getAttribute('content')).toBe('#ffffff');
  });

  it('falls back to the default theme for an unknown value', () => {
    applyTheme('sepia');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('reads back what is currently applied', () => {
    applyTheme(DARK);
    expect(currentTheme()).toBe(DARK);
    applyTheme(LIGHT);
    expect(currentTheme()).toBe(LIGHT);
  });
});
