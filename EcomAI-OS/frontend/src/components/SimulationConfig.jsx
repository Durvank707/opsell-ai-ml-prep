import React, { useMemo, useState } from 'react';
import { Play, FlaskConical, Info, X } from 'lucide-react';
import Button from './ui/Button';
import Card from './ui/Card';
import ProductCombobox from './ProductCombobox';
import { Field, Input } from './ui/form';
import {
  COST_ASSUMPTIONS,
  CUSTOM_POLICY_FIELDS,
  FORECASTING_ROLE_NOTE,
  INVENTORY_POLICIES,
  SIMULATION_DISCLAIMER,
  SIMULATION_PURPOSE,
  SIMULATION_SCOPE_NOTE,
  customPolicyParams,
  policyLabel,
} from '../services/simulationPolicy';

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

function Step({ number, title, description, children }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">
          {number}
        </span>
        <div>
          <p className="text-sm font-bold text-slate-900">{title}</p>
          {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
        </div>
      </div>
      <div className="pl-9">{children}</div>
    </div>
  );
}

/** The cost field's plain-language meaning, looked up by its request key. */
function costMeaning(name) {
  return COST_ASSUMPTIONS.find((entry) => entry.name === name)?.meaning || '';
}

export default function SimulationConfig({
  products,
  dataRange = null,
  onRun,
  running = false,
  progressStep = '',
}) {
  const fallback = useMemo(() => defaultWindow(null), []);
  const preview = useMemo(() => defaultWindow(dataRange), [dataRange]);
  const defaultStart = preview.start || fallback.start;
  const defaultEnd = preview.end || fallback.end;

  const [productId, setProductId] = useState(products.length > 0 ? products[0].id : '');
  const [customEnabled, setCustomEnabled] = useState(false);
  const [customValues, setCustomValues] = useState(() =>
    Object.fromEntries(CUSTOM_POLICY_FIELDS.map((field) => [field.name, ''])),
  );
  const [customError, setCustomError] = useState(null);
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [periodIsDefault, setPeriodIsDefault] = useState(true);
  const [orderingCost, setOrderingCost] = useState(500);
  const [stockoutCost, setStockoutCost] = useState(1000);

  const selectedProduct = products.find((p) => p.id === productId) || null;

  const handleRun = () => {
    const base = {
      productIds: productId ? [productId] : [],
      startDate,
      endDate,
      periodIsDefault,
      orderingCost: Number(orderingCost) || 0,
      stockoutCost: Number(stockoutCost) || 0,
    };

    // No strategy is chosen here. Every preset runs in the one request, and the
    // custom strategy is added to that same run when the experiment is switched
    // on — so the presets are always compared against each other, and a custom
    // value can never travel alongside a preset selection, because there is no
    // preset selection to travel with.
    if (!customEnabled) {
      onRun({ ...base, customEnabled: false, customParams: null });
      return;
    }

    const { params, error } = customPolicyParams(customValues);
    if (error) {
      setCustomError(error);
      return;
    }
    setCustomError(null);
    onRun({ ...base, customEnabled: true, customParams: Object.keys(params).length ? params : null });
  };

  const toggleCustom = () => {
    const next = !customEnabled;
    setCustomEnabled(next);
    // The error belongs to a panel that is no longer open; leaving it would
    // surface as a stray red line under the run button.
    if (!next) setCustomError(null);
  };

  return (
    <Card title="Set up a simulation" subtitle={SIMULATION_PURPOSE}>
      <div className="space-y-6">
        <Step
          number="1"
          title="Product to simulate"
          description={SIMULATION_SCOPE_NOTE}
        >
          {/* A searchable box rather than a select: the catalog is hundreds of
              products long, and the run is scoped to exactly one of them, so
              finding that one is the whole job of this field. It holds the same
              product id the API is sent. */}
          <ProductCombobox
            id="sim-product"
            label="Product"
            hint="Search the catalog to find the product to replay."
            products={products}
            value={productId}
            onChange={setProductId}
          />
          {selectedProduct && (
            <p className="mt-2 text-xs text-slate-400">
              {selectedProduct.category ? `${selectedProduct.category} · ` : ''}
              Lead time {selectedProduct.leadTimeDays ?? '—'} days
              {selectedProduct.currentStock !== undefined
                ? ` · ${selectedProduct.currentStock} units on hand`
                : ''}
            </p>
          )}
        </Step>

        <Step
          number="2"
          title="Simulation period"
          description="The window of recorded sales the simulation replays."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Start date" htmlFor="sim-start">
              <Input
                id="sim-start"
                type="date"
                value={startDate || ''}
                max={endDate || undefined}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setPeriodIsDefault(false);
                }}
              />
            </Field>
            <Field label="End date" htmlFor="sim-end">
              <Input
                id="sim-end"
                type="date"
                value={endDate || ''}
                min={startDate || undefined}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setPeriodIsDefault(false);
                }}
              />
            </Field>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            {periodIsDefault
              ? 'Default period: the most recent recorded sales window. Leave it untouched to let EcomAI-OS pick the range from your history.'
              : 'A custom period. The simulation needs some recorded history before the start date to estimate an opening stock.'}
          </p>
        </Step>

        <Step
          number="3"
          title="Cost assumptions"
          description="Used only to price the simulated inventory and stockouts. Both are optional."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Ordering cost (₹ per order)"
              htmlFor="sim-ordering-cost"
              hint={costMeaning('ordering_cost_per_order')}
            >
              <Input
                id="sim-ordering-cost"
                type="number"
                min="0"
                value={orderingCost}
                onChange={(e) => setOrderingCost(Number(e.target.value))}
              />
            </Field>
            <Field
              label="Stockout cost (₹ per unit)"
              htmlFor="sim-stockout-cost"
              hint={costMeaning('stockout_cost_per_unit')}
            >
              <Input
                id="sim-stockout-cost"
                type="number"
                min="0"
                value={stockoutCost}
                onChange={(e) => setStockoutCost(Number(e.target.value))}
              />
            </Field>
          </div>
        </Step>

        <Step number="4" title="Run the simulation">
          {/* The strategies the run will cover, stated before it happens so the
              comparison is never a surprise. This is a preview, not a choice:
              nothing here can be turned off. */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
            <p className="text-xs font-semibold text-slate-600">
              One run replays all of these against the same recorded demand:
            </p>
            <ul className="mt-2 space-y-1.5">
              {INVENTORY_POLICIES.filter((entry) => !entry.acceptsCustom).map((entry) => (
                <li key={entry.key} className="flex items-baseline gap-2 text-xs">
                  <span className="font-semibold text-slate-800">{entry.label}</span>
                  <span className="text-slate-500">{entry.description}</span>
                </li>
              ))}
              {customEnabled && (
                <li className="flex items-baseline gap-2 text-xs">
                  <span className="font-semibold text-brand-700">
                    {policyLabel('custom')}
                  </span>
                  <span className="text-slate-500">
                    {INVENTORY_POLICIES.find((e) => e.key === 'custom')?.description}
                  </span>
                </li>
              )}
            </ul>
          </div>

          <Button
            onClick={handleRun}
            loading={running}
            icon={running ? undefined : Play}
            disabled={!productId}
            className="mt-3 w-full sm:w-auto"
          >
            {running ? 'Running simulation…' : 'Run Simulation'}
          </Button>
          {running && progressStep && <p className="mt-2 text-xs text-slate-400">{progressStep}</p>}

          {/* The optional experiment, deliberately below the CTA: it changes what
              the run contains, so it is offered after the main action rather
              than as another required decision above it. */}
          <div className="mt-4 border-t border-slate-100 pt-4">
            {!customEnabled ? (
              <button
                type="button"
                onClick={toggleCustom}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-600 hover:text-brand-700"
              >
                <FlaskConical className="h-3.5 w-3.5" />
                + Test Custom Policy
              </button>
            ) : (
              <div className="space-y-3 rounded-xl border border-brand-100 bg-brand-50/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-bold text-slate-900">
                    Custom policy experiment
                  </p>
                  <button
                    type="button"
                    onClick={toggleCustom}
                    aria-label="Close custom policy experiment"
                    className="rounded-md p-1 text-slate-400 hover:bg-white hover:text-slate-600"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-xs text-slate-500">
                  Adds one more strategy to the comparison, alongside Current,
                  Conservative and Aggressive. {INVENTORY_POLICIES.find((e) => e.key === 'custom')?.description}
                </p>
                <p className="flex items-start gap-2 text-xs text-slate-500">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" />
                  These are the only policy parameters the simulator applies. Leave a
                  field blank to use the current policy&apos;s own value.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {CUSTOM_POLICY_FIELDS.map((field) => (
                    <Field
                      key={field.name}
                      label={field.label}
                      hint={field.hint}
                      htmlFor={`sim-custom-${field.name}`}
                    >
                      <Input
                        id={`sim-custom-${field.name}`}
                        type="number"
                        min={field.min}
                        step={field.integer ? 1 : 0.5}
                        value={customValues[field.name]}
                        placeholder={field.placeholder}
                        onChange={(e) => {
                          // A number input reports text it cannot represent as an
                          // empty value, which is indistinguishable from a field the
                          // user left blank — and blank means "use the current
                          // policy's value". Without this, pasted nonsense would
                          // quietly run a different policy than the one on screen.
                          const badInput = e.target.value === '' && e.target.validity?.badInput;
                          setCustomError(
                            badInput ? `${field.label.replace(/\s*\(.*\)$/, '')} must be a number.` : null,
                          );
                          setCustomValues((values) => ({
                            ...values,
                            [field.name]: e.target.value,
                          }));
                        }}
                      />
                    </Field>
                  ))}
                </div>
                {customError && (
                  <p className="text-xs font-semibold text-rose-600">{customError}</p>
                )}
              </div>
            )}
          </div>
        </Step>

        <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {SIMULATION_DISCLAIMER}
        </p>
        <p className="flex items-start gap-2 text-xs text-slate-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {FORECASTING_ROLE_NOTE}
        </p>
      </div>
    </Card>
  );
}
