import React, { useId } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../theme/ThemeContext';
import { DARK, LIGHT } from '../theme/theme';
import { cn } from '../lib/utils';

/**
 * The one place the application theme can be changed.
 *
 * The icon shows the theme you would move to, and the accessible name says the
 * same thing in words ("Switch to dark mode") so the control never depends on
 * recognising a glyph or on colour. A hidden description carries the state
 * itself, so a screen reader hears both the action and where things stand.
 */
export default function ThemeToggle({ className }) {
  const { theme, toggleTheme } = useTheme();
  const stateId = useId();
  const isDark = theme === DARK;
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={cn(
        'shrink-0 rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900',
        className,
      )}
      aria-label={label}
      aria-describedby={stateId}
      title={label}
      data-theme-toggle=""
      data-theme-state={theme}
    >
      {isDark ? (
        <Sun className="h-5 w-5" aria-hidden="true" />
      ) : (
        <Moon className="h-5 w-5" aria-hidden="true" />
      )}
      <span id={stateId} className="sr-only">
        {isDark ? 'Dark theme is on.' : 'Light theme is on.'}
      </span>
    </button>
  );
}
