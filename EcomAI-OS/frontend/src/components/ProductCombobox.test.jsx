// The searchable product picker on the Simulation page.
//
// The page offered a plain <select> over the whole catalog, which in a real
// tenant is hundreds of rows. Finding one product meant opening a list and
// scanning it, and browsers disagree about whether typing in a closed select
// jumps to an option. These tests pin the replacement: a typed query that
// matches on name or product ID, the same product id handed to the
// simulation API, and no request of any kind while the user types.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProductCombobox from './ProductCombobox';

const HEADPHONES = {
  id: 'WE-0178',
  name: 'Wireless Headphones',
  category: 'Electronics',
  leadTimeDays: 7,
  currentStock: 60,
};
const MOUSE = {
  id: 'GA-0057',
  name: 'Gaming Mouse RGB',
  category: 'Gaming',
  leadTimeDays: 5,
  currentStock: 22,
};
const LAMP = {
  id: 'OF-0203',
  name: 'LED Desk Lamp',
  category: 'Office',
  leadTimeDays: 10,
  currentStock: 8,
};
const CATALOG = [HEADPHONES, MOUSE, LAMP];

function renderCombobox(props = {}) {
  const onChange = vi.fn();
  render(
    <ProductCombobox
      products={CATALOG}
      value=""
      onChange={onChange}
      id="product"
      {...props}
    />,
  );
  return { onChange, ...props };
}

const box = () => screen.getByRole('combobox');
const list = () => screen.queryByRole('listbox');
const options = () => screen.queryAllByRole('option');

/** Type a query, which is what opens the list. */
function type(value) {
  fireEvent.change(box(), { target: { value } });
}

/** Click into the box, which opens the list over the whole catalog. */
function browse() {
  fireEvent.click(box());
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('searching by name', () => {
  it('finds a product by the whole of its name', () => {
    renderCombobox();
    type('Wireless Headphones');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('Wireless Headphones');
  });

  it('finds a product by part of its name', () => {
    renderCombobox();
    // "mouse" is a substring of "Gaming Mouse RGB", not the whole of it.
    type('mouse');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('Gaming Mouse RGB');
  });

  it('finds every product whose name contains the query', () => {
    renderCombobox();
    // "e" reaches all three: Wireles-s, Mous-e, L-ED. A single letter is the
    // widest query a user can type, so it is the one that has to work.
    type('e');
    const names = options().map((option) => option.textContent);
    expect(names.some((name) => name.includes('Wireless Headphones'))).toBe(true);
    expect(names.some((name) => name.includes('Gaming Mouse RGB'))).toBe(true);
    expect(names.some((name) => name.includes('LED Desk Lamp'))).toBe(true);
  });

  it('shows the name, the product ID and the category of each match', () => {
    renderCombobox();
    type('Lamp');
    const option = options()[0];
    expect(within(option).getByText('LED Desk Lamp')).toBeInTheDocument();
    // The product id is what the API is called with, so it has to be visible.
    expect(within(option).getByText(/OF-0203/)).toBeInTheDocument();
    expect(within(option).getByText(/Office/)).toBeInTheDocument();
  });
});

describe('searching by product ID', () => {
  it('finds a product by its exact id', () => {
    renderCombobox();
    type('OF-0203');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('LED Desk Lamp');
  });

  it('finds a product by part of its id', () => {
    renderCombobox();
    type('WE-01');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('Wireless Headphones');
  });

  it('finds a product by a name fragment and an id fragment alike', () => {
    renderCombobox();
    type('Gaming');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('GA-0057');
  });
});

describe('the query is normalized', () => {
  it('matches whatever case the user typed', () => {
    renderCombobox();
    type('wIrElEsS hEaDpHoNeS');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('Wireless Headphones');
  });

  it('matches an id typed in lower case', () => {
    renderCombobox();
    type('of-0203');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('LED Desk Lamp');
  });

  it('matches a name typed in upper case', () => {
    renderCombobox();
    type('MOUSE');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('Gaming Mouse RGB');
  });

  it('ignores whitespace around the query', () => {
    // The defect this inherits its fix from: the query was checked for
    // emptiness trimmed but then compared untrimmed, so a stray space stopped
    // every match.
    renderCombobox();
    type('   wireless headphones   ');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('Wireless Headphones');
  });

  it('ignores a query that is only whitespace, and shows the catalog', () => {
    renderCombobox();
    type('    ');
    // Whitespace is not a search, so nothing is filtered out.
    expect(options()).toHaveLength(CATALOG.length);
  });

  it('matches an id with whitespace inside it, as typed', () => {
    renderCombobox();
    type(' OF-0203 ');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('LED Desk Lamp');
  });
});

describe('when nothing matches', () => {
  it('says so, rather than showing an empty box', () => {
    renderCombobox();
    type('telescope');
    expect(options()).toHaveLength(0);
    expect(screen.getByText('No product found')).toBeInTheDocument();
  });

  it('says so for a query that matches no id either', () => {
    renderCombobox();
    type('ZZ-9999');
    expect(screen.getByText('No product found')).toBeInTheDocument();
  });

  it('lets the user type again after finding nothing', () => {
    renderCombobox();
    type('telescope');
    expect(screen.getByText('No product found')).toBeInTheDocument();
    type('lamp');
    expect(options()).toHaveLength(1);
    expect(screen.queryByText('No product found')).toBeNull();
  });

  it('has nothing to offer in an empty catalog', () => {
    renderCombobox({ products: [] });
    type('anything');
    expect(screen.getByText('No product found')).toBeInTheDocument();
  });
});

describe('choosing a product', () => {
  it('reports the id of the product that was chosen', () => {
    const { onChange } = renderCombobox();
    type('Lamp');
    fireEvent.mouseDown(options()[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
    // The id, not the name: this is the value the simulation API is sent.
    expect(onChange).toHaveBeenCalledWith('OF-0203');
  });

  it('chooses the product matching the id the user typed', () => {
    const { onChange } = renderCombobox();
    type('GA-0057');
    fireEvent.mouseDown(options()[0]);
    expect(onChange).toHaveBeenCalledWith('GA-0057');
  });

  it('picks the highlighted product when a query has several matches', () => {
    const { onChange } = renderCombobox();
    // "RGB" matches only the mouse, "Gaming" only the mouse too -- so search on
    // a term that both a name and an id share is what produces several.
    type('-');
    expect(options().length).toBeGreaterThan(1);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(CATALOG.map((product) => product.id)).toContain(onChange.mock.calls[0][0]);
  });

  it('closes the list after a choice, so the run is not run against a search', () => {
    renderCombobox();
    type('Lamp');
    fireEvent.mouseDown(options()[0]);
    expect(list()).toBeNull();
  });

  it('replaces the searched text with the chosen name, not the other way round', () => {
    // Leaving the search text behind is how a combobox ends up claiming to be
    // scoped to a product the user did not pick: the box would go on reading
    // "lamp" while the selection was something else.
    renderCombobox();
    type('Lamp');
    fireEvent.mouseDown(options()[0]);
    expect(box().value).toBe('LED Desk Lamp');
  });

  it('marks the chosen product as the selected option', () => {
    renderCombobox({ value: 'OF-0203' });
    browse();
    const selected = options().filter((option) => option.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('LED Desk Lamp');
  });

  it('offers the current selection first, so the picker opens on it', () => {
    // This is a browse convenience, not a search result: it applies while the
    // box still shows the chosen product's name. Once the user types, the list
    // is what they asked for.
    renderCombobox({ value: 'GA-0057' });
    browse();
    expect(options()[0].textContent).toContain('Gaming Mouse RGB');
  });

  it('browses the whole catalog while the box still shows the selection', () => {
    // Clicking in has to show the catalog, not one row: a search is only a
    // search once the text is something the user chose.
    renderCombobox({ value: 'GA-0057' });
    browse();
    expect(options()).toHaveLength(CATALOG.length);
  });

  it('drops the current selection from the list once a query is typed', () => {
    // The mouse is already chosen. Searching for the lamp must not leave the
    // mouse at the top of the results, where it could be picked by accident.
    renderCombobox({ value: 'GA-0057' });
    type('Lamp');
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain('LED Desk Lamp');
  });

  it('keeps the current selection in the list when the query matches it too', () => {
    renderCombobox({ value: 'OF-0203' });
    type('lamp');
    expect(options()).toHaveLength(1);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
  });

  it('shows the current selection in the box when it opens', () => {
    // The name in the box is the only record of what the run is scoped to, so
    // it has to survive being opened and closed.
    renderCombobox({ value: 'GA-0057' });
    browse();
    expect(box().value).toBe('Gaming Mouse RGB');
  });

  it('restores the selected name in the box after the search is abandoned', () => {
    renderCombobox({ value: 'GA-0057' });
    type('lamp');
    expect(box().value).toBe('lamp');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box().value).toBe('Gaming Mouse RGB');
  });

  it('keeps the selected name in the box after a choice', () => {
    renderCombobox({ value: 'GA-0057' });
    type('Lamp');
    fireEvent.mouseDown(options()[0]);
    expect(box().value).toBe('LED Desk Lamp');
  });
});

describe('nothing is requested while typing', () => {
  it('never calls back with a product as the user types', () => {
    // A combobox that reported a match on every keystroke would either run the
    // simulation repeatedly or, worse, keep a stale id in the payload.
    const { onChange } = renderCombobox();
    type('w');
    type('wi');
    type('wir');
    type('wireless headphones');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('holds the same products it was given, with no loader to call', () => {
    // The catalog arrives from the page as a prop, so the search is a
    // comparison over memory. There is no fetch path to fire.
    const { onChange } = renderCombobox();
    type('lamp');
    expect(onChange).not.toHaveBeenCalled();
    expect(list()).toBeInTheDocument();
  });

  it('does not report a product when the list is empty', () => {
    const { onChange } = renderCombobox();
    type('telescope');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('keyboard use', () => {
  it('opens the list on arrow down without changing the selection', () => {
    const { onChange } = renderCombobox();
    expect(list()).toBeNull();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(list()).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('moves through the list and selects with arrow down then enter', () => {
    const { onChange } = renderCombobox();
    fireEvent.keyDown(box(), { key: 'ArrowDown' }); // opens
    fireEvent.keyDown(box(), { key: 'ArrowDown' }); // second row
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(CATALOG[1].id);
  });

  it('moves backwards with arrow up, wrapping to the end', () => {
    const { onChange } = renderCombobox();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowUp' }); // wraps to the last row
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(CATALOG[CATALOG.length - 1].id);
  });

  it('jumps to the ends with home and end', () => {
    const { onChange } = renderCombobox();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'End' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(CATALOG[CATALOG.length - 1].id);
  });

  it('keeps focus in the box, so typing continues uninterrupted', () => {
    // DOM focus never leaves the input: the highlight is announced through
    // aria-activedescendant instead of by moving focus to a row.
    renderCombobox();
    box().focus();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box()).toHaveFocus();
    expect(document.activeElement).toBe(box());
  });

  it('points the active option at the highlighted row for screen readers', () => {
    renderCombobox();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    const activeId = box().getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    expect(options()[0].getAttribute('id')).toBe(activeId);
  });

  it('says the list is expanded and what it is', () => {
    renderCombobox();
    expect(box().getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().getAttribute('aria-expanded')).toBe('true');
    // The popup is named after the box it belongs to, so a screen reader can
    // say what it is announcing, but not with the box's own name — two controls
    // both called "Product" is ambiguous.
    expect(list().getAttribute('aria-label')).toBe('Product suggestions');
  });

  it('closes on escape and gives the keystroke back to the form', () => {
    renderCombobox();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(list()).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(list()).toBeNull();
  });

  it('selects the highlighted product on tab, so leaving the field keeps the choice', () => {
    const { onChange } = renderCombobox();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Tab' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('leaves Enter alone when the list is closed, so the form still submits', () => {
    const { onChange } = renderCombobox();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does nothing on arrow keys when there is nothing to move through', () => {
    const { onChange } = renderCombobox({ products: [] });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('a long list', () => {
  const many = Array.from({ length: 200 }, (_, index) => ({
    id: `SKU-${String(index).padStart(3, '0')}`,
    name: `Product ${index}`,
    category: 'General',
  }));

  it('caps the rendered rows and says how many matched', () => {
    // 200 products all match a query of "1", but a picker is not a browser: the
    // box is meant to be typed into. Rendering all of them would put thousands
    // of nodes in the DOM for no benefit.
    renderCombobox({ products: many });
    type('1');
    expect(options().length).toBeGreaterThan(0);
    expect(options().length).toBeLessThan(50);
    expect(screen.getByText(/Showing the first \d+ of \d+ matches/)).toBeInTheDocument();
  });

  it('says nothing about trimming when everything fits', () => {
    renderCombobox();
    type('Lamp');
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });
});

describe('a disabled picker', () => {
  it('cannot be opened or searched', () => {
    renderCombobox({ disabled: true });
    expect(box()).toBeDisabled();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(list()).toBeNull();
  });
});
