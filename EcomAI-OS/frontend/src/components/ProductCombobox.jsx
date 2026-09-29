import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from '../lib/utils';
import { matchesQuery, normalizeQuery } from '../services/productSearch';

// A searchable product picker, following the ARIA 1.2 combobox pattern.
//
// The Simulation page had a plain <select> over the whole catalog, which in a
// real tenant is hundreds of rows: finding one product meant opening a list and
// scanning it, and browsers differ on whether typing jumps to an option. The
// catalog is already loaded and held by the page, so searching here is a
// comparison over memory — no request is made while the user types, and a run is
// never triggered by typing either.
//
// Focus stays in the text input for the whole interaction. The active option is
// announced through `aria-activedescendant` rather than by moving DOM focus, so
// tabbing away from the field still behaves the way a form user expects and a
// screen reader keeps reading the box the user is typing in.
//
// The matching itself is `services/productSearch.js`, shared with the Forecast
// page: the query is trimmed and case-folded, and a product matches on either
// its name or its product ID.

/**
 * How many matches to put in the list at once.
 *
 * A one-letter query can match most of the catalog. Rendering every row would
 * put thousands of nodes in the DOM for no benefit — the box is not meant to be
 * browsed, it is meant to be typed into — so the list is capped and says how
 * many matched in total rather than pretending those are all of them.
 */
const MAX_RESULTS = 25;

export default function ProductCombobox({
  products = [],
  value,
  onChange,
  label = 'Product',
  hint,
  placeholder = 'Search by product name or ID…',
  emptyMessage = 'No product found',
  id,
  disabled = false,
}) {
  const generatedId = useId();
  const inputId = id || `product-combobox-${generatedId}`;
  const listId = `${inputId}-list`;

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);
  // Read inside the pointer handler, which must know whether a click is a
  // selection or merely the click that closes the list.
  const openRef = useRef(open);
  openRef.current = open;

  const selected = useMemo(
    () => (products || []).find((product) => product.id === value) || null,
    [products, value],
  );

  // What is in the box and what is in the list are two different questions.
  //
  // On opening, the box shows the product already chosen — that name is the only
  // record of the current selection, and a box that went blank on every click
  // would hide it. But the user is browsing then, not searching, so the list is
  // the whole catalog with that product at the top.
  //
  // A search starts the moment the text is something other than that name, and
  // from then on the list is results only. Holding the old selection at the top
  // of a real search is how a run gets made against a product the user just
  // typed past.
  const needle = normalizeQuery(query);
  const browsing = !needle || (selected && needle === normalizeQuery(selected.name));

  const matches = useMemo(() => {
    const list = browsing
      ? products || []
      : (products || []).filter((product) => matchesQuery(needle, product));
    if (!browsing || !selected) return list;
    return [selected, ...list.filter((product) => product.id !== selected.id)];
  }, [products, needle, browsing, selected]);

  const shown = useMemo(() => matches.slice(0, MAX_RESULTS), [matches]);

  // A shorter list must not leave the highlight pointing past the end.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const closeList = useCallback(() => {
    setOpen(false);
    // The box goes back to naming the chosen product rather than to whatever
    // was last typed, so closing the picker never erases the selection from
    // sight.
    setQuery(selected ? selected.name : '');
  }, [selected]);

  // A click anywhere else closes the list. Registered on the document rather
  // than on a wrapper's blur, because clicking an option inside the wrapper
  // would otherwise be indistinguishable from clicking outside it.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) closeList();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, closeList]);

  const select = useCallback(
    (product) => {
      if (!product) return;
      onChange(product.id);
      // The box returns to the chosen product's name, so reopening the picker
      // shows the current choice rather than the text that was searched for.
      setQuery(product.name);
      setOpen(false);
    },
    [onChange],
  );

  const openList = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    if (selected) setQuery(selected.name);
  }, [disabled, selected]);

  const onKeyDown = (event) => {
    if (disabled) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!openRef.current) {
        setOpen(true);
        if (selected) setQuery(selected.name);
        return;
      }
      if (!matches.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (activeIndex + step + matches.length) % matches.length;
      setActiveIndex(next);
      return;
    }

    if (event.key === 'Home' && open) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }

    if (event.key === 'End' && open) {
      event.preventDefault();
      setActiveIndex(Math.max(0, matches.length - 1));
      return;
    }

    if (event.key === 'Enter') {
      if (open && matches[activeIndex]) {
        // Only swallow Enter when it is choosing an option. An empty list is
        // not a selection, and a closed box is a form, so Enter must still
        // submit what the user filled in.
        event.preventDefault();
        select(matches[activeIndex]);
      }
      return;
    }

    if (event.key === 'Escape') {
      if (!open) return;
      // Escape abandons the search but keeps the product that was already
      // chosen, so the box goes back to naming it rather than going blank.
      event.preventDefault();
      closeList();
      return;
    }

    if (event.key === 'Tab') {
      // Moving on commits the list the way a blur would, but only when a
      // product is actually highlighted; otherwise Tab is just Tab.
      if (open && matches[activeIndex]) select(matches[activeIndex]);
    }
  };

  const activeOptionId = open && matches[activeIndex] ? `${listId}-option-${activeIndex}` : undefined;

  return (
    <div className="relative" ref={rootRef}>
      <label className="label" htmlFor={inputId}>
        {label}
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <input
          id={inputId}
          type="text"
          role="combobox"
          className="input pl-9"
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={openList}
          onKeyDown={onKeyDown}
          // Focus lands on the whole current value so the first keystroke
          // replaces the product name rather than appending to it.
          onClick={(event) => {
            if (!open) {
              openList();
              event.currentTarget.select();
            }
          }}
        />
      </div>

      {hint && <p className="mt-1.5 text-xs text-slate-400">{hint}</p>}

      {open && (
        <div
          id={listId}
          role="listbox"
          // Named, but not with the box's own name: two controls answering to
          // "Product" makes a label lookup ambiguous, and the popup is a list of
          // what the box is suggesting, not a second Product field.
          aria-label={`${label} suggestions`}
          className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          {shown.length === 0 && (
            <p className="px-3 py-4 text-center text-sm text-slate-500">{emptyMessage}</p>
          )}

          {shown.map((product, index) => {
            const isSelected = product.id === value;
            const isActive = index === activeIndex;
            return (
              <div
                key={product.id}
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                // The highlight is drawn rather than focused, which is what lets
                // the input keep focus for the whole interaction.
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  // Keep focus in the input: the default mousedown behaviour
                  // moves focus to the list, which would collapse the picker
                  // before the click landed.
                  event.preventDefault();
                  select(product);
                }}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm',
                  isActive ? 'bg-brand-50' : 'hover:bg-slate-50',
                )}
              >
                <span className="block font-semibold text-slate-800">{product.name}</span>
                <span className="block text-xs text-slate-500">
                  {product.id}
                  {product.category ? ` · ${product.category}` : ''}
                </span>
              </div>
            );
          })}

          {matches.length > shown.length && (
            <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-400">
              Showing the first {shown.length} of {matches.length} matches. Keep typing to
              narrow it down.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
