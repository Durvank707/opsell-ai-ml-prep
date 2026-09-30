// The application shell: a viewport-fixed navigation panel beside the content.
//
// The panel used to be an ordinary flex child of a `min-h-screen` row. Flex
// stretches its children to the tallest one, so on any page taller than the
// viewport — the Simulation results, a long catalog — the panel grew to the full
// page height. Its own `overflow-y-auto` never engaged, because the element was
// already as tall as its content; what scrolled was the document, dragging an
// enormous blank panel with it. On a laptop the panel was 4,000px of mostly
// nothing.
//
// jsdom computes no layout, so these tests assert the declarations that produce
// the behaviour — position, the internal scroller, and where the content's width
// is reserved — rather than measuring boxes. That is the honest boundary: the
// claim under test is "the panel is fixed to the viewport and the page scrolls",
// and that is a property of the classes and the DOM shape, not of a number.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = { id: 'tenant-a', name: 'Aarav Mehta', email: 'a@example.com' };
const logout = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const markAllRead = vi.fn();
const refresh = vi.fn();

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: USER, logout }),
}));

vi.mock('../../context/ToastContext', () => ({
  useToast: () => toast,
}));

vi.mock('../../context/DataContext', () => ({
  useData: () => ({ notifications: [], unread: 0, markAllRead, refresh }),
}));

const inventory = vi.hoisted(() => ({ listProducts: vi.fn() }));
vi.mock('../../services/inventoryService', () => inventory);

import AppShell from './AppShell';

const sidebar = () => screen.getByTestId('app-sidebar');
const content = () => screen.getByTestId('app-content');
const drawer = () => screen.getByTestId('app-mobile-drawer');
const collapseButton = () => screen.getByRole('button', { name: /collapse sidebar/i });
const openMenuButton = () => screen.getByRole('button', { name: /open menu/i });
const closeMenuButton = () => screen.getByRole('button', { name: /close menu/i });

const hasClass = (node, cls) => node.className.split(/\s+/).includes(cls);

/**
 * A page far taller than any viewport, which is the situation that used to
 * stretch the panel. The height is declared inline so the intent is readable;
 * nothing reads it, because jsdom does not lay out.
 */
function TallPage({ blocks = 40 }) {
  return (
    <div data-testid="tall-page">
      {Array.from({ length: blocks }, (_, i) => (
        <div key={i} style={{ height: 240 }} data-testid={`block-${i}`} />
      ))}
    </div>
  );
}

function renderShell({ blocks = 40 } = {}) {
  return render(
    <MemoryRouter initialEntries={['/app/simulation']}>
      <Routes>
        <Route path="/app" element={<AppShell />}>
          <Route path="simulation" element={<TallPage blocks={blocks} />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** Everything inside the content column, as a comparable string. */
function contentShape() {
  return content().innerHTML;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  inventory.listProducts.mockResolvedValue({ items: [] });
});

describe('the panel is fixed to the viewport', () => {
  it('is taken out of the page flow, so page height cannot size it', () => {
    renderShell();
    const panel = sidebar();
    expect(hasClass(panel, 'fixed')).toBe(true);
    // `inset-y-0` pins it between the top and bottom of the viewport, which is
    // what "does not stretch with the content" means in CSS.
    expect(panel.className).toContain('inset-y-0');
  });

  it('is not a column beside the content, so there is no row to stretch', () => {
    renderShell();
    // The shell root used to be `flex min-h-screen`, which made the panel a flex
    // item and therefore as tall as its tallest sibling.
    const root = content().parentElement;
    expect(hasClass(root, 'flex')).toBe(false);
    expect(hasClass(root, 'min-h-screen')).toBe(true);
    // And the panel is not inside the content column it sits beside.
    expect(content().contains(sidebar())).toBe(false);
  });

  it('keeps the long page in the document, not inside the panel', () => {
    renderShell({ blocks: 60 });
    // The failure mode was the panel growing around the content. The content
    // belongs to `main` and the panel is its sibling's sibling.
    const page = screen.getByTestId('tall-page');
    expect(screen.getByRole('main')).toContainElement(page);
    expect(sidebar().contains(page)).toBe(false);
    expect(page.querySelectorAll('[data-testid^="block-"]')).toHaveLength(60);
  });

  it('clips its own surface, so nothing paints below the fold', () => {
    renderShell();
    expect(hasClass(sidebar(), 'overflow-hidden')).toBe(true);
  });
});

describe('the panel scrolls itself only when it must', () => {
  it('gives its navigation an internal scrollbar', () => {
    renderShell();
    // The one case where the panel legitimately scrolls is a viewport too short
    // to hold the nav, the collapse control and the user card. `flex-1` lets the
    // nav take the leftover height and `overflow-y-auto` lets it scroll inside
    // the panel instead of the page.
    const nav = sidebar().querySelector('nav').parentElement;
    expect(hasClass(nav, 'flex-1')).toBe(true);
    expect(hasClass(nav, 'overflow-y-auto')).toBe(true);
  });

  it('does not put a scroll container around the page content', () => {
    renderShell();
    // `overflow-x-hidden` on `main` is pre-existing and horizontal only. A
    // vertical scroller here is what produced nested scrollbars.
    const main = screen.getByRole('main');
    expect(main.className).not.toMatch(/overflow-y-/);
    expect(main.className).not.toMatch(/max-h-/);
  });
});

describe('the content reserves the panel width', () => {
  it('as padding, not as a sibling column', () => {
    renderShell();
    // A padding offset is what lets the panel be `fixed` while the content keeps
    // its full width. A flex sibling would put the panel back in the flow.
    expect(hasClass(content(), 'lg:pl-64')).toBe(true);
    expect(content().className).not.toMatch(/flex-1|w-64|w-\[72px\]/);
  });

  it('narrows the same padding when the panel is collapsed', () => {
    renderShell();
    fireEvent.click(collapseButton());
    expect(hasClass(content(), 'lg:pl-[72px]')).toBe(true);
    expect(content().className).not.toContain('lg:pl-64');
  });

  it('keeps the panel and the content offset in step', () => {
    renderShell();
    expect(sidebar().className).toContain('w-64');
    fireEvent.click(collapseButton());
    expect(sidebar().className).toContain('w-[72px]');
  });
});

describe('collapsing does not disturb the page', () => {
  it('changes the width reservation and nothing about the content', () => {
    renderShell();
    const before = contentShape();
    const pageBefore = screen.getByTestId('tall-page').childElementCount;

    fireEvent.click(collapseButton());

    // Every requirement here is the same: the height of the page's content must
    // be identical before and after, because the panel is no longer one of the
    // boxes the content is measured against.
    expect(contentShape()).toBe(before);
    expect(screen.getByTestId('tall-page').childElementCount).toBe(pageBefore);
  });

  it('leaves the panel itself the same height either way', () => {
    renderShell();
    const classes = sidebar().className;
    fireEvent.click(collapseButton());
    // Only the width token differs; the viewport-pinning classes are untouched,
    // which is why collapsing cannot reflow the page.
    const changed = classes
      .split(/\s+/)
      .filter((cls) => !sidebar().className.split(/\s+/).includes(cls));
    expect(changed).toEqual(['w-64']);
    expect(changed.every((cls) => cls.startsWith('w-'))).toBe(true);
  });
});

describe('the panel on a small screen', () => {
  it('is closed, and unreachable by keyboard, until it is asked for', () => {
    renderShell();
    expect(drawer()).toHaveAttribute('inert');
  });

  it('opens with the menu button and takes focus so it can be driven from the keyboard', () => {
    renderShell();
    openMenuButton().focus();
    fireEvent.click(openMenuButton());
    expect(drawer()).not.toHaveAttribute('inert');
    expect(closeMenuButton()).toHaveFocus();
  });

  it('closes on Escape, returning focus to the button that opened it', () => {
    renderShell();
    openMenuButton().focus();
    fireEvent.click(openMenuButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(drawer()).toHaveAttribute('inert');
    // Focus must not be dumped on the body, or the next Tab restarts at the top
    // of the document.
    expect(openMenuButton()).toHaveFocus();
  });

  it('closes on its own close button, for the same reason', () => {
    renderShell();
    openMenuButton().focus();
    fireEvent.click(openMenuButton());
    fireEvent.click(closeMenuButton());
    expect(drawer()).toHaveAttribute('inert');
    expect(openMenuButton()).toHaveFocus();
  });

  it('is the same fixed overlay the long page sits behind', () => {
    renderShell();
    fireEvent.click(openMenuButton());
    // `inset-y-0` again: on a phone the drawer covers the screen height, not the
    // document height, so a long Simulation page cannot stretch it either.
    expect(drawer().className).toContain('inset-y-0');
    expect(drawer().className).toContain('fixed');
    // Fits the viewport on a narrow screen.
    expect(drawer().className).toContain('max-w-[85vw]');
  });

  it('scrolls its own links when they do not fit', () => {
    renderShell();
    fireEvent.click(openMenuButton());
    const list = drawer().querySelector('nav').parentElement;
    expect(hasClass(list, 'overflow-y-auto')).toBe(true);
    expect(hasClass(list, 'flex-1')).toBe(true);
  });

  it('does not trap focus — the links inside are ordinary tab stops', () => {
    renderShell();
    fireEvent.click(openMenuButton());
    // A drawer that trapped focus would make the page behind it unreachable.
    // The nav is a plain list of links, with no focus sentinels around it.
    const nav = drawer().querySelector('nav');
    expect(nav.querySelectorAll('a[href]').length).toBeGreaterThan(3);
    expect(nav.querySelector('[tabindex]')).toBeNull();
  });
});

describe('the panel on the Simulation page', () => {
  it('renders the page and the panel as siblings on the same route', () => {
    renderShell();
    // The scenario from the bug report, at the route it was reported on. The
    // nav link is read from the panel itself: the mobile drawer carries a second
    // copy of the same nav, so an unscoped query would find both.
    expect(screen.getByTestId('tall-page')).toBeInTheDocument();
    expect(sidebar()).toBeInTheDocument();
    expect(
      within(sidebar()).getByRole('link', { name: /simulation/i }),
    ).toBeInTheDocument();
  });

  it('leaves the page content reachable while the drawer is open on a long page', () => {
    renderShell({ blocks: 60 });
    fireEvent.click(openMenuButton());
    // Nothing about the long page is hidden or replaced by opening the panel.
    expect(screen.getByRole('main')).toContainElement(screen.getByTestId('tall-page'));
    expect(contentShape()).toContain('tall-page');
  });
});
