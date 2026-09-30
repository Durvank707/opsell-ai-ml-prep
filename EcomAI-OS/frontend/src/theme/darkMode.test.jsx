// Dark mode, audited across the surfaces the app actually ships.
//
// How this is built matters, so the shape of the tests is unusual. There is no
// `dark:` variant anywhere in the components: the theme is a palette swap
// declared once in index.css and mapped in tailwind.config.js. So there is
// nothing per-component to test, and the honest question is whether the swap is
// really as global as it claims to be.
//
// Two kinds of answer, both used here:
//
//   1. Static. The first block reads the source tree and fails if a component
//      grows a `dark:` override, hardcodes a colour, or reaches for a chart hex.
//      That is what keeps the mechanism centralised - it is the one thing a
//      visual check cannot keep honest across eighty files.
//   2. Behavioural. Everything else renders real components under the dark
//      theme and asserts what the user depends on: the toggle is present, the
//      combobox still searches, the simulation tabs still switch, a modal still
//      traps and closes, the login form still validates.
//
// jsdom loads no stylesheet, so no assertion here can be about a pixel. What
// the static block guarantees is that the pixels come from themed tokens; what
// these tests guarantee is that the themed tokens are applied to markup that
// still works.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CHART_TOKENS } from './chartTokens';
import { ThemeProvider } from './ThemeContext';
import { DARK, LIGHT } from './theme';

// The palette map itself, read the way Tailwind reads it - the same file the
// build uses, so a colour family dropped from it is dropped here too.
const { default: tailwindConfig } = await import('../../tailwind.config.js');

// ---------------------------------------------------------------------------
// Source tree, for the static half.
// ---------------------------------------------------------------------------

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every .jsx/.js file under src, excluding the tests themselves. */
function sourceFiles(dir = SRC, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'test' || entry === 'node_modules') continue;
      sourceFiles(full, found);
    } else if (/\.(jsx|js)$/.test(entry) && !/\.test\.(jsx|js)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

const COMPONENT_FILES = sourceFiles().filter((file) => !file.includes(`${sep}theme${sep}`));

/** The only files allowed to contain literal colours. */
const COLOUR_EXCEPTIONS = [
  // The brand mark. A logo is a fixed identity, not a themed surface.
  join(SRC, 'components', 'layout', 'Logo.jsx'),
  // Decorative artwork on the auth brand panel, which is dark in both themes.
  join(SRC, 'pages', 'auth', 'AuthLayout.jsx'),
  // Where the palette lives.
  join(SRC, 'theme', 'chartTokens.js'),
  join(SRC, 'theme', 'theme.js'),
];

const relativeToSrc = (file) => relative(SRC, file).split(sep).join('/');

/** Source with comments removed, so prose about a rule cannot trip the rule. */
const withoutComments = (file) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ---------------------------------------------------------------------------

const USER = { name: 'Dana Okafor', email: 'dana@example.com' };
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: USER, login: vi.fn(), enterDemo: vi.fn() }) }));
vi.mock('../context/DataContext', () => ({
  useData: () => ({ notifications: [], unread: 0, markAllRead: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../context/ToastContext', () => ({ useToast: () => toast, useToastState: () => ({ toasts: [], remove: vi.fn() }) }));
vi.mock('../services/inventoryService', () => ({ listProducts: vi.fn().mockResolvedValue({ items: [] }) }));

const { default: ThemeToggle } = await import('../components/ThemeToggle');
const { default: Button } = await import('../components/ui/Button');
const { default: Card } = await import('../components/ui/Card');
const { default: Modal, ConfirmDialog } = await import('../components/ui/Modal');
const { default: EmptyState } = await import('../components/ui/EmptyState');
const { Skeleton } = await import('../components/ui/Skeleton');
const { Badge } = await import('../components/ui/Badge');
const { Field, Input, Select, Textarea, Toggle } = await import('../components/ui/form');
const { default: ProductCombobox } = await import('../components/ProductCombobox');
const { default: Header } = await import('../components/layout/Header');
const { default: AuthLayout } = await import('../pages/auth/AuthLayout');
const { default: LoginPage } = await import('../pages/auth/LoginPage');
const { default: SimulationConfig } = await import('../components/SimulationConfig');
const { default: SimulationResults } = await import('../components/SimulationResults');
const { toSimulationResult } = await import('../services/simulationResult');
const { INVENTORY_POLICIES } = await import('../services/simulationPolicy');

// The results panel's graph is exercised by its own tests; here it would only
// put a recharts render between the panel and the assertions about it.
vi.mock('../components/charts', () => ({ StockLineChart: () => <div data-testid="stock-chart" /> }));

/** Render under a named theme, the way the app mounts them. */
function renderDark(ui, theme = DARK) {
  return render(
    <ThemeProvider storage={null} matchMedia={null} initialTheme={theme}>
      {ui}
    </ThemeProvider>,
  );
}

const isDark = () => document.documentElement.classList.contains('dark');

beforeEach(() => {
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
});

// ===========================================================================

describe('the theme is centralised rather than repeated per component', () => {
  it('has no dark-mode variant in any component', () => {
    // This is the load-bearing claim. A `dark:` class would mean a component
    // carrying its own second set of styles, which is exactly what the token
    // layer exists to avoid.
    const offenders = COMPONENT_FILES.filter((file) =>
      /(?<![\w-])dark:(?![\w-])/.test(withoutComments(file)),
    );
    expect(offenders.map(relativeToSrc)).toEqual([]);
  });

  it('hardcodes no colours outside the palette and the brand artwork', () => {
    // `#4f46e5` in a component is a colour that will not follow the theme.
    const allowed = COLOUR_EXCEPTIONS.map(relativeToSrc);
    const offenders = COMPONENT_FILES.filter((file) => {
      const source = withoutComments(file);
      if (!/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\brgba?\(/.test(source)) return false;
      return !allowed.includes(relativeToSrc(file));
    });
    expect(offenders.map(relativeToSrc)).toEqual([]);
  });

  it('gives both chart themes the same set of roles', () => {
    // Charts cannot use CSS custom properties - recharts hands colours to SVG
    // presentation attributes, where var() is not allowed - so their palette is
    // JS. The guarantee worth having is that the two themes describe the same
    // chart, so nothing silently disappears in one of them.
    expect(Object.keys(CHART_TOKENS.light).sort()).toEqual(Object.keys(CHART_TOKENS.dark).sort());
    expect(Object.keys(CHART_TOKENS.light)).toContain('axis');
    expect(Object.keys(CHART_TOKENS.light)).toContain('grid');
    expect(Object.keys(CHART_TOKENS.light)).toContain('lost');
    expect(Object.keys(CHART_TOKENS.light)).toContain('reorder');
  });

  it('actually re-picks the chart colours for the dark theme', () => {
    const hex = /^#[0-9a-f]{6}$/i;
    for (const [role, value] of Object.entries(CHART_TOKENS.light)) {
      expect(value, `light ${role}`).toMatch(hex);
      expect(CHART_TOKENS.dark[role], `dark ${role}`).toMatch(hex);
    }
    // A palette swap that left everything unchanged would be an inverted
    // light theme, which is the failure this feature is meant to avoid.
    const changed = Object.keys(CHART_TOKENS.light).filter(
      (role) => CHART_TOKENS.light[role] !== CHART_TOKENS.dark[role],
    );
    expect(changed).toEqual(expect.arrayContaining(['axis', 'grid', 'actual', 'forecast', 'lost', 'reorder']));
  });
});

// ===========================================================================
//
// The coverage of the swap itself.
//
// The token layer only works if it covers every colour the app actually uses.
// A family it misses does not fail loudly: Tailwind still generates
// `bg-violet-50/50` from its own default palette, and that default is a
// near-white, so the page comes out with a light panel in the dark theme and
// nothing anywhere reports a problem. That is not hypothetical - it is how
// violet and cyan were found. These two tests are the check that keeps a new
// colour family from quietly opting out.

describe('the palette covers every colour the app uses', () => {
  it('maps every colour family in the source tree to a theme token', () => {
    // The colour maps are functions of `theme`, so they are asked rather than
    // read: this is the palette Tailwind will actually resolve utilities
    // against, not a re-derivation of it.
    const themedFor = (property) =>
      tailwindConfig.theme.extend[property]({ theme: () => ({}) });
    const backgrounds = themedFor('backgroundColor');

    // Utilities only, not prose: a Tailwind colour prefix has to sit
    // immediately before the family.
    const utilities =
      /(?:^|[\s"'`:])(?:sm:|md:|lg:|xl:|hover:|focus:|focus-visible:|active:|disabled:|even:)*(?:bg|text|border|ring|from|to|via|fill|stroke|divide|decoration|outline|placeholder|accent|caret|shadow)-([a-z][a-z0-9]*?)-\d{2,3}\b/g;

    const used = new Map();
    for (const file of [...COMPONENT_FILES, join(SRC, 'index.css')]) {
      const source = withoutComments(file);
      for (const [, family] of source.matchAll(utilities)) {
        if (backgrounds[family]) continue;
        if (!used.has(family)) used.set(family, new Set());
        used.get(family).add(relativeToSrc(file));
      }
    }

    // Empty is the point. A family missing here keeps Tailwind's own palette,
    // which is a light theme's worth of colours painted into the dark one.
    expect(
      [...used.entries()].map(([family, files]) => `${family} (${[...files].join(', ')})`),
    ).toEqual([]);
  });

  it('declares every token the config asks for, in both themes', () => {
    // A token named in the config but missing from one of the two blocks would
    // resolve to nothing in that theme - an unstyled colour rather than a wrong
    // one, which is even harder to notice.
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    const declared = (block) =>
      new Set([...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));

    const light = declared(css.slice(css.indexOf(':root {'), css.indexOf('.dark {')));
    const dark = declared(css.slice(css.indexOf('.dark {')));

    const asked = [
      'backgroundColor',
      'textColor',
      'borderColor',
      'ringColor',
      'gradientColorStops',
    ].flatMap((property) => {
      const palette = tailwindConfig.theme.extend[property]({ theme: () => ({}) });
      return Object.values(palette).flatMap((shades) =>
        typeof shades === 'string' ? [shades] : Object.values(shades ?? {}),
      );
    });
    const tokens = [...new Set(asked.map(String))].filter((v) => v.startsWith('--'));

    expect(tokens.filter((token) => !light.has(token))).toEqual([]);
    expect(tokens.filter((token) => !dark.has(token))).toEqual([]);
  });
});

// ===========================================================================

describe('shared UI primitives under the dark theme', () => {
  it('renders every button variant with its name intact', () => {
    renderDark(
      <div>
        {['primary', 'secondary', 'ghost', 'danger', 'danger-soft'].map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </div>,
    );

    for (const variant of ['primary', 'secondary', 'ghost', 'danger', 'danger-soft']) {
      expect(screen.getByRole('button', { name: variant })).toBeInTheDocument();
    }
  });

  it('keeps a disabled button disabled and legible to assistive tech', () => {
    renderDark(<Button disabled>Run Simulation</Button>);
    const button = screen.getByRole('button', { name: 'Run Simulation' });
    expect(button).toBeDisabled();
    // The disabled look is the shared `.btn` class rather than a variant on the
    // element, so the control keeps its name and stays in the accessibility
    // tree - a screen reader still announces it, as unavailable.
    expect(button).toHaveClass('btn-primary');
  });

  it('renders every badge tone', () => {
    renderDark(
      <div>
        {['neutral', 'green', 'amber', 'red', 'blue', 'indigo', 'gray'].map((tone) => (
          <Badge key={tone} tone={tone} dot>
            {tone}
          </Badge>
        ))}
      </div>,
    );
    for (const tone of ['neutral', 'green', 'amber', 'red', 'blue', 'indigo', 'gray']) {
      expect(screen.getByText(tone)).toBeInTheDocument();
    }
  });

  it('renders cards, empty states and loading placeholders', () => {
    renderDark(
      <div>
        <Card title="Inventory health">Body</Card>
        <EmptyState title="Nothing here yet" description="Add a product to begin." />
        <Skeleton />
      </div>,
    );

    expect(screen.getByText('Inventory health')).toBeInTheDocument();
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
    expect(screen.getByText('Add a product to begin.')).toBeInTheDocument();
  });

  it('keeps form controls labelled and operable', () => {
    const onChange = vi.fn();
    renderDark(
      <div>
        <Field label="Product" htmlFor="p">
          <Input id="p" defaultValue="Widget" />
        </Field>
        <Field label="Strategy" htmlFor="s">
          <Select id="s" defaultValue="a">
            <option value="a">Conservative</option>
          </Select>
        </Field>
        <Field label="Notes" htmlFor="n">
          <Textarea id="n" defaultValue="hello" />
        </Field>
        <Toggle label="Include custom" checked={false} onChange={onChange} />
      </div>,
    );

    expect(screen.getByLabelText('Product')).toHaveValue('Widget');
    expect(screen.getByLabelText('Strategy')).toHaveValue('a');
    expect(screen.getByLabelText('Notes')).toHaveValue('hello');

    const toggle = screen.getByRole('switch', { name: /Include custom/ });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

// ===========================================================================

describe('the searchable ProductCombobox under the dark theme', () => {
  const CATALOG = [
    { id: 'WE-0178', name: 'Wireless Headphones', category: 'Electronics' },
    { id: 'GA-0057', name: 'Gaming Mouse RGB', category: 'Gaming' },
  ];

  function renderBox() {
    const onChange = vi.fn();
    renderDark(<ProductCombobox products={CATALOG} value="" onChange={onChange} id="product" />);
    return onChange;
  }

  it('opens a listbox over the whole catalog', () => {
    renderBox();
    const box = screen.getByRole('combobox');
    expect(box).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(box);

    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('narrows to what was typed, and says so when nothing matches', () => {
    renderBox();
    const box = screen.getByRole('combobox');

    fireEvent.change(box, { target: { value: 'mouse' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Gaming Mouse RGB');

    fireEvent.change(box, { target: { value: 'nothing at all' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No product found')).toBeInTheDocument();
  });

  it('still hands the product id back, so a run is made against the right product', () => {
    const onChange = renderBox();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'headphones' } });
    fireEvent.mouseDown(screen.getAllByRole('option')[0]);

    expect(onChange).toHaveBeenCalledWith('WE-0178');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('marks the current selection on the option, not by colour', () => {
    const onChange = vi.fn();
    renderDark(
      <ProductCombobox products={CATALOG} value="WE-0178" onChange={onChange} id="product" />,
    );
    fireEvent.click(screen.getByRole('combobox'));

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');
  });
});

// ===========================================================================

describe('the Simulation page under the dark theme', () => {
  const CATALOG = [
    { id: 'P001', name: 'Wireless Headphones', category: 'Electronics', currentStock: 60, leadTimeDays: 7 },
  ];

  function policyRow(key, label, overrides = {}) {
    const entry = INVENTORY_POLICIES.find((p) => p.key === key);
    return {
      key,
      label,
      description: entry?.description || '',
      safety_stock: 20,
      coverage_days: 7,
      average_reorder_point: 74.5,
      average_order_up_to: 74.5,
      stockout_days: 2,
      stockout_units: 14,
      service_level: 96.4,
      average_inventory: 41.5,
      maximum_inventory: 88,
      excess_inventory: 12.25,
      number_of_orders: 6,
      total_units_ordered: 310,
      holding_cost: 1200.5,
      ordering_cost: 3000,
      stockout_cost: 14000,
      total_inventory_cost: 18200.5,
      ...overrides,
    };
  }

  const timeline = () => [
    {
      date: '2025-01-01', demand: 11, arrival_qty: 0, units_fulfilled: 11, stockout_units: 0,
      closing_stock: 50, open_order_units: 0, inventory_position: 50, order_qty: 0,
      reorder_required: false, reorder_point: 74.5, target_inventory: 74.5, safety_stock: 20,
    },
  ];

  const payload = {
    product_id: 'P001',
    product_name: 'Wireless Headphones',
    start_date: '2025-01-01',
    end_date: '2025-03-31',
    duration_days: 90,
    unit_cost: 1000,
    starting_stock: 60,
    safety_stock: 20,
    forecast_error_std: 4.2,
    lead_time_days: 7,
    scope: 'single_product',
    policies_evaluated: ['current', 'conservative', 'aggressive'],
    policy: { key: 'current', label: 'Current Policy', safety_stock: 20, coverage_days: 7, parameters: {} },
    policy_comparison: [
      policyRow('current', 'Current Policy'),
      policyRow('conservative', 'Conservative'),
      policyRow('aggressive', 'Aggressive'),
    ],
    policy_timelines: { current: timeline(), conservative: timeline(), aggressive: timeline() },
    xgb_metrics: { stockout_days: 2, service_level: 96.4, average_inventory: 41.5 },
    baseline_metrics: { stockout_days: 4, service_level: 92, average_inventory: 33 },
    cost_comparison: { recommended_strategy: 'xgboost', expected_savings: 100 },
  };

  it('renders the setup form, with the combobox working', () => {
    renderDark(<SimulationConfig products={CATALOG} onRun={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Run Simulation/i })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'headphones' } });
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Wireless Headphones');
  });

  it('renders the results, with one tab per strategy and the graph behind them', () => {
    renderDark(<SimulationResults results={toSimulationResult(payload, { mode: 'api' })} onRunAnother={vi.fn()} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('stock-chart')).toBeInTheDocument();

    // The third arm is whatever the result lists last, whichever strategy that
    // is; the point is that the strip switches and the graph follows.
    fireEvent.click(tabs[2]);
    expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('stock-chart')).toBeInTheDocument();
  });

  it('keeps the model evaluation collapsed, so it does not compete with the answer', () => {
    renderDark(<SimulationResults results={toSimulationResult(payload, { mode: 'api' })} onRunAnother={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: /forecast model evaluation/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('model-details-panel')).toBeInTheDocument();
  });
});

// ===========================================================================

describe('overlays under the dark theme', () => {
  // Note: the dialog has no programmatic name - it ships a visible <h2> but no
  // aria-labelledby. That is pre-existing and unchanged by the theme, so it is
  // left alone here and reported rather than quietly fixed.
  it('renders a modal as a dialog, with its title and a working close', () => {
    const onClose = vi.fn();
    renderDark(
      <Modal open onClose={onClose} title="Confirm" description="This cannot be undone.">
        <p>Body</p>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Confirm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes a modal on Escape, as it does in the light theme', () => {
    const onClose = vi.fn();
    renderDark(
      <Modal open onClose={onClose} title="Confirm">
        <p>Body</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('draws the backdrop from the scrim token, not from a fixed colour', () => {
    // The scrim has to stay dark in both themes; if it followed the neutral ramp
    // it would invert and wash the page out behind the dialog.
    renderDark(
      <Modal open onClose={vi.fn()} title="Confirm">
        <p>Body</p>
      </Modal>,
    );
    const backdrop = document.querySelector('.backdrop-blur-\\[2px\\]');
    expect(backdrop).toBeInTheDocument();
    expect(backdrop.className).toContain('bg-slate-900/40');
  });

  it('renders a destructive confirmation with its own tone', () => {
    renderDark(
      <ConfirmDialog open onClose={vi.fn()} onConfirm={vi.fn()} message="Delete this product?" />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Delete this product?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('opens and closes the header dropdown, which is the app’s main overlay', () => {
    renderDark(
      <MemoryRouter>
        <Header onMenuClick={vi.fn()} onLogout={vi.fn()} />
      </MemoryRouter>,
    );

    const bell = screen.getByRole('button', { name: 'Notifications' });
    expect(screen.queryByText('Notifications', { selector: 'p' })).not.toBeInTheDocument();

    fireEvent.click(bell);

    expect(screen.getByText('You’re all caught up.')).toBeInTheDocument();

    // Dismissed by a click anywhere outside, which is the header's mousedown
    // handler rather than a click handler - a pointer that starts elsewhere and
    // ends over the panel should not keep the panel open.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('You’re all caught up.')).not.toBeInTheDocument();
  });
});

// ===========================================================================

describe('the theme toggle in the global header', () => {
  function renderHeader() {
    return renderDark(
      <MemoryRouter initialEntries={['/app']}>
        <Header onMenuClick={vi.fn()} onLogout={vi.fn()} />
      </MemoryRouter>,
    );
  }

  it('is the one place in the app header that changes the theme', () => {
    renderHeader();
    expect(screen.getAllByRole('button', { name: /^Switch to (dark|light) mode$/ })).toHaveLength(1);
  });

  it('moves the whole document, not just the header', () => {
    renderHeader();
    expect(isDark()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));

    expect(isDark()).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

// ===========================================================================

describe('the authentication pages under the dark theme', () => {
  it('offers the same toggle, because those pages sit outside the app shell', () => {
    renderDark(
      <MemoryRouter>
        <AuthLayout>
          <p>Sign in</p>
        </AuthLayout>
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeInTheDocument();
    expect(screen.getByText('Sign in')).toBeInTheDocument();
  });

  it('keeps the brand panel dark in both themes, because white text sits on it', () => {
    const { unmount } = renderDark(
      <MemoryRouter>
        <AuthLayout>
          <p>Sign in</p>
        </AuthLayout>
      </MemoryRouter>,
    );
    const panel = document.querySelector('.surface-inverse');
    expect(panel).toBeInTheDocument();
    expect(panel.className).not.toContain('bg-slate-900');
    unmount();

    renderDark(
      <MemoryRouter>
        <AuthLayout>
          <p>Sign in</p>
        </AuthLayout>
      </MemoryRouter>,
      LIGHT,
    );
    expect(document.querySelector('.surface-inverse')).toBeInTheDocument();
  });

  it('leaves the login form working', () => {
    renderDark(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    const email = screen.getByPlaceholderText('you@company.com');

    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    expect(screen.getByText('Please enter your email address.')).toBeInTheDocument();

    fireEvent.change(email, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    expect(screen.getByText('Please enter a valid email address.')).toBeInTheDocument();
  });
});
