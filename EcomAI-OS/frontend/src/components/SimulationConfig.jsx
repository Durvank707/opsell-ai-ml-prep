import React, { useMemo, useState } from 'react';
import { Play, FlaskConical, Info } from 'lucide-react';
import Button from './ui/Button';
import Card from './ui/Card';
import ProductCombobox from './ProductCombobox';
import { Field, Input } from './ui/form';
import { cn } from '../lib/utils';
import {
  CUSTOM_POLICY_FIELDS,
  CUSTOM_POLICY_KEY,
  FORECAST_COMPARISON_NOTE,
  FORECAST_METHODS,
  INVENTORY_POLICIES,
  SIMULATION_DISCLAIMER,
  SIMULATION_SCOPE_NOTE,
  customPolicyParams,
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
  const [policy, setPolicy] = useState('current');
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
    if (policy === CUSTOM_POLICY_KEY) {
      const { params, error } = customPolicyParams(customValues);
      if (error) {
        setCustomError(error);
        return;
      }
      setCustomError(null);
      onRun({
        productIds: productId ? [productId] : [],
        policy,
        policyParams: Object.keys(params).length ? params : null,
        startDate,
        endDate,
        periodIsDefault,
        orderingCost: Number(orderingCost) || 0,
        stockoutCost: Number(stockoutCost) || 0,
      });
      return;
    }

    onRun({
      productIds: productId ? [productId] : [],
      policy,
      policyParams: null,
      startDate,
      endDate,
      periodIsDefault,
      orderingCost: Number(orderingCost) || 0,
      stockoutCost: Number(stockoutCost) || 0,
    });
  };

  return (
    <Card
      title="Set up a simulation"
      subtitle="Replay historical sales and see how an inventory policy would have performed."
    >
      <div className="space-y-6">
        <Step
          number="1"
          title="Product to simulate"
          description="Simulation evaluates one product at a time."
        >
          {/* A searchable box rather than a select: the catalog is hundreds of
              products long, and the run is scoped to exactly one of them, so
              finding that one is the whole job of this field. It holds the same
              product id the API is sent. */}
          <ProductCombobox
            id="sim-product"
            label="Product"
            hint={SIMULATION_SCOPE_NOTE}
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
          title="Inventory policy"
          description="How should inventory be managed?"
        >
          <div className="space-y-2">
            {INVENTORY_POLICIES.map((option) => (
              <label
                key={option.key}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                  policy === option.key
                    ? 'border-brand-400 bg-brand-50/60 ring-1 ring-brand-200'
                    : 'border-slate-200 hover:border-slate-300',
                )}
              >
                <input
                  type="radio"
                  name="policy"
                  className="mt-0.5 accent-brand-600"
                  checked={policy === option.key}
                  onChange={() => setPolicy(option.key)}
                />
                <span>
                  <span className="block text-sm font-semibold text-slate-800">
                    {option.label}
                  </span>
                  <span className="block text-xs text-slate-500">{option.description}</span>
                </span>
              </label>
            ))}
          </div>

          {policy === CUSTOM_POLICY_KEY && (
            <div className="mt-3 space-y-3 rounded-xl border border-brand-100 bg-brand-50/40 p-4">
              <p className="flex items-start gap-2 text-xs text-slate-500">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" />
                These are the only policy parameters the simulator applies. Leave a
                field blank to use the current policy's own value.
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
              {customError && <p className="text-xs font-semibold text-rose-600">{customError}</p>}
            </div>
          )}
        </Step>

        <Step
          number="3"
          title="Historical period to replay"
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
          number="4"
          title="Cost assumptions (optional)"
          description="Used only to price the simulated inventory and stockouts."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Ordering cost (₹ per order)"
              htmlFor="sim-ordering-cost"
              hint="The fixed cost of placing one purchase order — admin, freight, handling."
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
              hint="The margin lost when a unit of demand cannot be fulfilled from stock."
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

        <Step number="5" title="Run the simulation">
          <Button
            onClick={handleRun}
            loading={running}
            icon={running ? undefined : Play}
            disabled={!productId}
            className="w-full sm:w-auto"
          >
            {running ? 'Running simulation…' : 'Run Simulation'}
          </Button>
          <p className="mt-2 text-xs text-slate-500">
            Replay historical sales and see how this policy would have performed.
          </p>
          {running && progressStep && <p className="mt-1 text-xs text-slate-400">{progressStep}</p>}
        </Step>

        {/* A different question from the policy above, so it gets its own
            heading rather than sitting inside the policy step. */}
        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-brand-600 ring-1 ring-slate-200">
              <FlaskConical className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-bold text-slate-900">
                Forecast comparison: which forecast performed better?
              </p>
              <p className="mt-0.5 text-xs text-slate-500">{FORECAST_COMPARISON_NOTE}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {FORECAST_METHODS.map((method) => (
                  <span
                    key={method.key}
                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600"
                    title={method.description}
                  >
                    {method.label}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-400">
                This compares forecasting methods, and is separate from the policy you
                choose above. It runs automatically with every simulation.
              </p>
            </div>
          </div>
        </div>

        <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {SIMULATION_DISCLAIMER}
        </p>
      </div>
    </Card>
  );
}
