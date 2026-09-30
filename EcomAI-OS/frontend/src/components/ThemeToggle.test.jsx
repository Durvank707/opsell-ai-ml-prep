// The theme toggle, and the persistence behind it.
//
// The toggle is the only way a user changes the theme, so these tests are about
// the whole loop rather than the button: it moves light to dark and back, it
// says out loud what it will do, it survives a reload, and it is reachable and
// operable from the keyboard. Nothing here reloads the page to check
// persistence — a reload is simulated by unmounting and mounting a fresh
// provider over the same storage, which is exactly what the browser does.

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeToggle from './ThemeToggle';
import { ThemeProvider } from '../theme/ThemeContext';
import { DARK, LIGHT, THEME_STORAGE_KEY } from '../theme/theme';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** A stand-in for window.matchMedia: called with a query, returns a list. */
const prefersDark = (matches) => () => ({
  matches,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

/** Mount the toggle the way the app does. */
function renderToggle({ storage = memoryStorage(), matchMedia = prefersDark(false) } = {}) {
  const result = render(
    <ThemeProvider storage={storage} matchMedia={matchMedia}>
      <ThemeToggle />
    </ThemeProvider>,
  );
  return { storage, matchMedia, ...result };
}

const toggle = () => screen.getByRole('button');
const appliedTheme = () => document.documentElement.dataset.theme;
const isDarkClass = () => document.documentElement.classList.contains('dark');

beforeEach(() => {
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
});

describe('switching between the two themes', () => {
  it('goes from light to dark', () => {
    renderToggle();
    expect(appliedTheme()).toBe('light');

    fireEvent.click(toggle());

    expect(appliedTheme()).toBe('dark');
    expect(isDarkClass()).toBe(true);
    expect(toggle()).toHaveAttribute('data-theme-state', 'dark');
  });

  it('goes from dark back to light', () => {
    renderToggle();
    fireEvent.click(toggle());
    expect(appliedTheme()).toBe('dark');

    fireEvent.click(toggle());

    expect(appliedTheme()).toBe('light');
    expect(isDarkClass()).toBe(false);
    expect(toggle()).toHaveAttribute('data-theme-state', 'light');
  });

  it('does not reload the page to change the theme', () => {
    // A theme change is a class on <html>, so the document has to survive it.
    renderToggle();
    const marker = document.createElement('div');
    marker.id = 'still-here';
    document.body.appendChild(marker);

    fireEvent.click(toggle());

    expect(document.getElementById('still-here')).toBe(marker);
    marker.remove();
  });

  it('starts from the system preference when nothing has been saved', () => {
    renderToggle({ matchMedia: prefersDark(true) });

    expect(appliedTheme()).toBe('dark');
    expect(toggle()).toHaveAttribute('data-theme-state', 'dark');
  });
});

describe('remembering the choice', () => {
  it('writes the chosen theme to storage', () => {
    const { storage } = renderToggle();

    fireEvent.click(toggle());

    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('comes back dark after a reload, even against a light system', () => {
    const storage = memoryStorage();
    const first = renderToggle({ storage });
    fireEvent.click(toggle());
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    first.unmount();

    // The reload: a brand new provider and a brand new toggle over the same
    // storage, which is all a page load is as far as the theme is concerned.
    renderToggle({ storage, matchMedia: prefersDark(false) });

    expect(appliedTheme()).toBe('dark');
    expect(toggle()).toHaveAttribute('data-theme-state', 'dark');
  });

  it('comes back light after a reload, even against a dark system', () => {
    const storage = memoryStorage();
    const first = renderToggle({ storage, matchMedia: prefersDark(true) });
    fireEvent.click(toggle());
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    first.unmount();

    renderToggle({ storage, matchMedia: prefersDark(true) });

    expect(appliedTheme()).toBe('light');
  });

  it('ignores the system once a choice has been made', () => {
    // A deliberate choice outranks the OS permanently, so the system flipping
    // at sunset must not move a page someone has already themed.
    const storage = memoryStorage();
    renderToggle({ storage, matchMedia: prefersDark(false) });
    fireEvent.click(toggle());
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    renderToggle({ storage, matchMedia: prefersDark(false) });

    expect(appliedTheme()).toBe('dark');
  });
});

describe('the toggle as an accessible control', () => {
  it('names the action it will take, not the state it is in', () => {
    renderToggle();
    expect(toggle()).toHaveAccessibleName('Switch to dark mode');
  });

  it('renames itself once the theme has changed', () => {
    renderToggle();
    fireEvent.click(toggle());

    expect(toggle()).toHaveAccessibleName('Switch to light mode');
  });

  it('states the current theme in words, not by colour', () => {
    renderToggle();
    // The name is the action; the description is the state, so a screen reader
    // hears both without the control depending on a glyph.
    expect(toggle()).toHaveAccessibleDescription('Light theme is on.');

    fireEvent.click(toggle());

    expect(toggle()).toHaveAccessibleDescription('Dark theme is on.');
  });

  it('offers the same name on hover, for a pointer user', () => {
    renderToggle();
    expect(toggle()).toHaveAttribute('title', 'Switch to dark mode');
  });

  it('is reachable and operable from the keyboard', () => {
    renderToggle();
    toggle().focus();
    expect(toggle()).toHaveFocus();

    // Enter and Space are what a button answers to; the assertion is that the
    // control is a real <button>, not a click handler on a div.
    expect(toggle().tagName).toBe('BUTTON');
    expect(toggle()).toHaveAttribute('type', 'button');

    fireEvent.keyDown(toggle(), { key: 'Enter' });
    fireEvent.keyUp(toggle(), { key: 'Enter' });
    fireEvent.click(toggle());

    expect(appliedTheme()).toBe('dark');
  });
});
