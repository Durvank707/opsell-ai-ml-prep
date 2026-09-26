import React, { useState } from 'react';
import { Play, Boxes } from 'lucide-react';
import Button from './ui/Button';
import Card from './ui/Card';
import { Field, Input, Select } from './ui/form';
import { cn } from '../lib/utils';

const POLICIES = [
  { key: 'current', label: 'Current Policy', desc: 'Your live safety stock & reorder settings' },
  { key: 'conservative', label: 'Conservative Policy', desc: 'Higher safety stock — fewer stockouts, more holding cost' },
  { key: 'aggressive', label: 'Aggressive Policy', desc: 'Leaner stock — lower cost, higher stockout risk' },
  { key: 'custom', label: 'Custom Policy', desc: 'Define your own safety stock and reorder levels' },
];

// The window the form previews when the user has not chosen one.
//
// This mirrors `TenantWorkspace.backtest`'s own default: the most recent ~90
// days of recorded demand, never starting earlier than a 28-day lead-in. The
// lead-in is not cosmetic — the engine derives the starting stock from rows
// strictly before the window, so a start date on the first recorded sale has
// nothing to work from and the run is refused. The server applies this rule
// itself, so an untouched form sends no dates at all and lets it decide; these
// values are what the user sees, and what the server would choose.
const BACKTEST_WINDOW_DAYS = 89;
const BACKTEST_LEAD_IN_DAYS = 28;

function defaultWindow(dataRange) {
  const today = new Date();
  const end = dataRange?.to ? new Date(dataRange.to) : today;
  if (Number.isNaN(end.getTime())) {
    return { start: null, end: null };
  }
  const first = dataRange?.from ? new Date(dataRange.from) : null;
  const ninetyDaysAgo = new Date(end);
  ninetyDaysAgo.setDate(end.getDate() - BACKTEST_WINDOW_DAYS);
  let start = ninetyDaysAgo;
  if (first && !Number.isNaN(first.getTime())) {
    const leadIn = new Date(first);
    leadIn.setDate(first.getDate() + BACKTEST_LEAD_IN_DAYS);
    if (leadIn > start) start = leadIn;
  }
  const toIso = (d) => d.toISOString().slice(0, 10);
  return { start: toIso(start), end: toIso(end) };
}

export default function SimulationConfig({ products, dataRange = null, onRun, running = false, progressStep = '' }) {
  const fallback = defaultWindow(null);
  const preview = defaultWindow(dataRange);
  const defaultStart = preview.start || fallback.start;
  const defaultEnd = preview.end || fallback.end;

  const [config, setConfig] = useState({
    startDate: defaultStart,
    endDate: defaultEnd,
    // Whether the period is still the preview above. While it is, no dates are
    // sent and the server picks the window from this tenant's own history,
    // which keeps the two from drifting apart.
    periodIsDefault: true,
    // A backtest compares two replenishment policies over one product's own
    // recorded demand, so a single product is the scope that comparison is
    // actually defined for. "All Products" stays selectable and says plainly
    // that it cannot be simulated rather than quietly running one product and
    // labelling it the catalog.
    productSelection: 'selected',
    productIds: products.length > 0 ? [products[0].id] : [],
    policy: 'current',
    customParams: {
      safetyStock: '',
      leadTime: '',
      reorderPoint: '',
      orderQuantity: '',
    },
    orderingCost: 500,
    stockoutCost: 1000,
    packSize: 1,
  });

  const set = (patch) => setConfig((c) => ({ ...c, ...patch }));

  const toggleProduct = (id) => {
    setConfig((c) => ({
      ...c,
      productIds: c.productIds.includes(id)
        ? c.productIds.filter((x) => x !== id)
        : [...c.productIds, id],
    }));
  };

  return (
    <Card
      title="Simulation Settings"
      subtitle="Test inventory policies against historical demand before applying them."
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Historical Period — Start Date">
            <Input
              type="date"
              value={config.startDate}
              max={config.endDate}
              onChange={(e) => set({ startDate: e.target.value, periodIsDefault: false })}
            />
          </Field>
          <Field label="End Date">
            <Input
              type="date"
              value={config.endDate}
              min={config.startDate}
              onChange={(e) => set({ endDate: e.target.value, periodIsDefault: false })}
            />
          </Field>
        </div>

        <div>
          <p className="label">Products</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => set({ productSelection: 'all' })}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors',
                config.productSelection === 'all'
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-slate-300 text-slate-600 hover:bg-slate-50',
              )}
            >
              All Products ({products.length})
            </button>
            <button
              onClick={() => set({ productSelection: 'selected' })}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors',
                config.productSelection === 'selected'
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-slate-300 text-slate-600 hover:bg-slate-50',
              )}
            >
              Selected Products
              {config.productIds.length > 0 && ` (${config.productIds.length})`}
            </button>
          </div>
          {config.productSelection === 'selected' && (
            <div className="mt-3 max-h-40 overflow-y-auto rounded-xl border border-slate-200 p-2">
              <div className="flex flex-wrap gap-1.5">
                {products.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => toggleProduct(p.id)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                      config.productIds.includes(p.id)
                        ? 'border-brand-300 bg-brand-50 text-brand-700'
                        : 'border-slate-200 text-slate-500 hover:bg-slate-50',
                    )}
                  >
                    <Boxes className="h-3 w-3" />
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <p className="label">Inventory Policy</p>
          <div className="space-y-2">
            {POLICIES.map((policy) => (
              <label
                key={policy.key}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                  config.policy === policy.key
                    ? 'border-brand-400 bg-brand-50/60 ring-1 ring-brand-200'
                    : 'border-slate-200 hover:border-slate-300',
                )}
              >
                <input
                  type="radio"
                  name="policy"
                  className="mt-0.5 accent-brand-600"
                  checked={config.policy === policy.key}
                  onChange={() => set({ policy: policy.key })}
                />
                <span>
                  <span className="block text-sm font-semibold text-slate-800">{policy.label}</span>
                  <span className="block text-xs text-slate-500">{policy.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {config.policy === 'custom' && (
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-brand-100 bg-brand-50/40 p-4">
            <Field label="Safety Stock">
              <Input
                type="number"
                min="0"
                value={config.customParams.safetyStock}
                onChange={(e) => set({ customParams: { ...config.customParams, safetyStock: e.target.value } })}
                placeholder="Units"
              />
            </Field>
            <Field label="Lead Time">
              <Input
                type="number"
                min="1"
                value={config.customParams.leadTime}
                onChange={(e) => set({ customParams: { ...config.customParams, leadTime: e.target.value } })}
                placeholder="Days"
              />
            </Field>
            <Field label="Reorder Point">
              <Input
                type="number"
                min="0"
                value={config.customParams.reorderPoint}
                onChange={(e) => set({ customParams: { ...config.customParams, reorderPoint: e.target.value } })}
                placeholder="Units"
              />
            </Field>
            <Field label="Order Quantity">
              <Input
                type="number"
                min="1"
                value={config.customParams.orderQuantity}
                onChange={(e) => set({ customParams: { ...config.customParams, orderQuantity: e.target.value } })}
                placeholder="Units"
              />
            </Field>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Always use Current Policy" className="hidden" />
          <Field label="Ordering Cost (₹/order)">
            <Input
              type="number"
              min="0"
              value={config.orderingCost}
              onChange={(e) => set({ orderingCost: Number(e.target.value) })}
            />
          </Field>
          <Field label="Stockout Cost (₹/unit)">
            <Input
              type="number"
              min="0"
              value={config.stockoutCost}
              onChange={(e) => set({ stockoutCost: Number(e.target.value) })}
            />
          </Field>
          <Field label="Order Pack Size">
            <Input type="number" min="1" value={config.packSize} onChange={(e) => set({ packSize: Number(e.target.value) })} />
          </Field>
        </div>

        <Button
          onClick={() => onRun(config)}
          loading={running}
          icon={running ? undefined : Play}
          className="w-full sm:w-auto"
        >
          {running ? 'Running simulation…' : 'Run Simulation'}
        </Button>
        {running && progressStep && <p className="text-xs text-slate-500">{progressStep}</p>}
      </div>
    </Card>
  );
}