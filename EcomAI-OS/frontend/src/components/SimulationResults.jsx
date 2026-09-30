import React, { useState } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  PackageSearch,
  Layers,
  ShoppingCart,
  IndianRupee,
  RefreshCw,
  Info,
  Workflow,
  ChevronDown,
} from 'lucide-react';
import Card from './ui/Card';
import Button from './ui/Button';
import { StockLineChart } from './charts';
import { formatINR, formatNumber, formatDate, plural } from '../lib/utils';
import {
  POLICY_METRICS,
  REPLENISHMENT_RULE,
  SIMULATION_STEPS,
} from '../services/simulationPolicy';
import { appliedCustomParameters } from '../services/simulationResult';

/**
 * A metric with the plain-English sentence that explains it.
 *
 * The card's own `sub` line is single-line and truncated, which is fine for a
 * caption but not for an explanation, so the helper text gets a full line of its
 * own here — and is repeated in the `title`, so hovering the card gives the same
 * words.
 */
function MetricCard({ icon: Icon, tone, label, value, helper, detail }) {
  return (
    <div className="card p-5" title={helper}>
      <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" />
      </span>
      <p className="mt-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p className="tnum mt-1 text-[26px] font-extrabold leading-none tracking-tight text-slate-900">
        {value}
      </p>
      {detail && <p className="mt-1.5 text-xs font-medium text-slate-500">{detail}</p>}
      <p className="mt-1 text-xs text-slate-400">{helper}</p>
    </div>
  );
}

/** The icons the KPI cards use, in the order `POLICY_METRICS` lists them. */
const METRIC_ICONS = {
  stockout_days: { icon: AlertTriangle, tone: 'bg-amber-50 text-amber-600' },
  service_level: { icon: ShieldCheck, tone: 'bg-emerald-50 text-emerald-600' },
  average_inventory: { icon: PackageSearch, tone: 'bg-sky-50 text-sky-600' },
  excess_inventory: { icon: Layers, tone: 'bg-brand-50 text-brand-600' },
  number_of_orders: { icon: ShoppingCart, tone: 'bg-indigo-50 text-indigo-600' },
};

const METRIC_ACCESSOR = {
  stockout_days: 'stockoutDays',
  service_level: 'serviceLevel',
  average_inventory: 'averageInventory',
  excess_inventory: 'excessInventory',
  number_of_orders: 'orders',
  total_inventory_cost: 'inventoryCost',
};

function formatMetric(metric, value) {
  switch (metric.format) {
    case 'percent':
      return `${value}%`;
    case 'currency':
      return formatINR(value);
    case 'days':
      return plural(value, 'day');
    case 'units':
      return `${formatNumber(Math.round(value))} units`;
    default:
      return formatNumber(value);
  }
}

/** The one strategy the graph is currently showing. */
function PolicyTabs({ keys, strategies, activeKey, onChange }) {
  if (keys.length < 2) return null;
  return (
    <div
      role="tablist"
      aria-label="Inventory strategy shown in the graph"
      className="flex flex-wrap gap-1.5"
    >
      {keys.map((key) => {
        const strategy = strategies.find((row) => row.key === key);
        const active = key === activeKey;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            id={`policy-tab-${key}`}
            aria-selected={active}
            aria-controls="inventory-timeline-panel"
            onClick={() => onChange(key)}
            className={
              active
                ? 'rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm'
                : 'rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }
          >
            {strategy?.label || key}
          </button>
        );
      })}
    </div>
  );
}

export default function SimulationResults({ results, onRunAnother }) {
  const strategies = results.strategies || [];
  const tabKeys = results.tabKeys || [];
  // The tab state lives here, not in the result object: it is a display choice
  // about data that has already been returned, so switching must never re-run
  // anything or reach for the network.
  const [activeKey, setActiveKey] = useState(
    () => results.initialPolicyKey || tabKeys[0] || null,
  );
  const [modelOpen, setModelOpen] = useState(false);

  // A new run replaces the result object; the previous tab may not exist in it.
  const safeKey = tabKeys.includes(activeKey) ? activeKey : tabKeys[0] || null;
  const active = strategies.find((row) => row.key === safeKey) || null;
  const customParams = appliedCustomParameters(results);

  const range =
    results.start && results.end
      ? `${formatDate(results.start)} → ${formatDate(results.end)}`
      : null;

  const comparisonRows = strategies.map((strategy) => ({
    key: strategy.key,
    label: strategy.label,
    sublabel: strategy.description,
    values: POLICY_METRICS.map((metric) =>
      formatMetric(metric, strategy[METRIC_ACCESSOR[metric.key]] ?? 0),
    ),
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-slate-900">
            How did the inventory strategies perform?
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {results.productName}
            {range ? ` · ${range}` : ''}
            {results.durationDays ? ` · ${plural(results.durationDays, 'day')}` : ''}
            {` · ${plural(strategies.length, 'strategy')} compared`}
          </p>
        </div>
        <Button variant="secondary" onClick={onRunAnother} icon={RefreshCw}>
          Run Another Simulation
        </Button>
      </div>

      {results.mode === 'mock' && (
        <p className="flex items-start gap-2 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Demo data is in use, so these figures come from a simplified browser
          replay of the same rule, not from the production engine.
        </p>
      )}

      {/* The answer in one sentence, before any table. */}
      <Card>
        <p className="text-base font-semibold leading-relaxed text-slate-800">
          {results.summary}
        </p>
        <p className="mt-2 text-xs text-slate-500">{results.disclaimer}</p>
      </Card>

      {/* What each strategy is, in the words used throughout the results. */}
      <Card
        title="The strategies compared"
        subtitle="Each one is a different way of deciding when to reorder"
      >
        <ul className="grid gap-2 sm:grid-cols-2">
          {strategies.map((strategy) => (
            <li
              key={strategy.key}
              className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5"
            >
              <p className="text-sm font-semibold text-slate-800">{strategy.label}</p>
              <p className="mt-0.5 text-xs text-slate-500">{strategy.description}</p>
              <p className="mt-1 text-[11px] text-slate-400">
                Safety stock {formatNumber(Math.round(strategy.safetyStock))} units
                {strategy.coverageDays
                  ? ` · orders cover ${strategy.coverageDays} days of demand`
                  : ''}
              </p>
            </li>
          ))}
        </ul>
        {customParams.length > 0 && (
          <p className="mt-3 text-xs text-slate-500">
            Custom policy used:{' '}
            {customParams.map((param) => `${param.label} ${param.value}`).join(', ')}.
          </p>
        )}
        <p className="mt-3 text-xs text-slate-400">{results.comparisonNote}</p>
      </Card>

      <Card
        title="Policy comparison"
        subtitle="The same product, the same recorded demand, the same days — only the strategy changes"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="table-th">Strategy</th>
                {POLICY_METRICS.map((metric) => (
                  <th
                    key={metric.key}
                    className="table-th text-right"
                    title={metric.meaning}
                  >
                    {metric.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {comparisonRows.map((row) => (
                <tr key={row.key}>
                  <td className="table-td">
                    <span className="block text-sm font-semibold text-slate-800">
                      {row.label}
                    </span>
                    <span className="block text-xs text-slate-400">{row.sublabel}</span>
                  </td>
                  {row.values.map((value, index) => (
                    <td
                      key={index}
                      className="table-td tnum text-right text-slate-600"
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* The column headings alone do not say what a number means, so each one
            spells itself out under the table. */}
        <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {POLICY_METRICS.map((metric) => (
            <div key={metric.key} className="flex items-baseline gap-2">
              <dt className="text-xs font-bold text-slate-600">{metric.label}</dt>
              <dd className="text-xs text-slate-400">{metric.meaning}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {/* The graph, for whichever strategy the tabs have selected. */}
      <Card
        title="Inventory over time"
        subtitle={
          active
            ? `Inventory over time — ${active.label} · ${active.description}`
            : 'Inventory over time'
        }
      >
        <PolicyTabs
          keys={tabKeys}
          strategies={strategies}
          activeKey={safeKey}
          onChange={setActiveKey}
        />
        <p className="mt-2 text-xs text-slate-400">{results.tabsNote}</p>

        <div
          id="inventory-timeline-panel"
          role="tabpanel"
          aria-labelledby={safeKey ? `policy-tab-${safeKey}` : undefined}
          className="mt-3"
        >
          {active && active.chart.length > 0 ? (
            <>
              {/* The numbers for the strategy on screen. They travel with the
                  tab so the graph is never read without its figures. */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {POLICY_METRICS.filter((metric) => metric.key !== 'total_inventory_cost').map(
                  (metric) => {
                    const { icon: Icon, tone } = METRIC_ICONS[metric.key];
                    const value = active[METRIC_ACCESSOR[metric.key]] ?? 0;
                    return (
                      <MetricCard
                        key={metric.key}
                        icon={Icon}
                        tone={tone}
                        label={metric.label}
                        value={formatMetric(metric, value)}
                        helper={metric.meaning}
                        detail={
                          metric.key === 'stockout_days'
                            ? `${plural(active.stockoutUnits, 'unit')} of demand lost`
                            : metric.key === 'number_of_orders'
                              ? `${plural(active.unitsOrdered, 'unit')} ordered in total`
                              : null
                        }
                      />
                    );
                  },
                )}
                <MetricCard
                  icon={IndianRupee}
                  tone="bg-rose-50 text-rose-600"
                  label="Inventory Cost"
                  value={formatINR(active.inventoryCost)}
                  helper="Simulated cost under the selected cost assumptions."
                  detail={`Holding ${formatINR(active.holdingCost)} · Orders ${formatINR(
                    active.orderingCost,
                  )} · Stockouts ${formatINR(active.stockoutCost)}`}
                />
              </div>

              <div className="mt-4">
                <StockLineChart
                  points={active.chart}
                  height={300}
                  reference={
                    active.reorderPoint
                      ? Math.round(active.reorderPoint)
                      : null
                  }
                  inTransitKey="inTransit"
                  lostKey="lost"
                  formatter={(value) => `${formatNumber(value)} units`}
                />
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Stock on hand fell to zero on {plural(active.stockout.days, 'day')}
                {active.stockout.events > 0
                  ? `, in ${plural(active.stockout.events, 'separate episode')}`
                  : ''}
                . A reorder was triggered on{' '}
                {plural(active.chart.filter((point) => point.orderQty > 0).length, 'day')}.
              </p>
            </>
          ) : (
            <p className="py-6 text-center text-xs text-slate-400">
              No inventory timeline was returned for this strategy.
            </p>
          )}
        </div>
      </Card>

      <Card title="How simulation works" subtitle="What happens on every replayed day">
        <ol className="flex flex-wrap items-center gap-2">
          {SIMULATION_STEPS.map((step, index) => (
            <li key={step} className="flex items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-100">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-brand-600 text-[10px] font-bold text-white">
                  {index + 1}
                </span>
                {step}
              </span>
              {index < SIMULATION_STEPS.length - 1 && (
                <Workflow className="hidden h-3 w-3 rotate-90 text-slate-300 sm:block sm:rotate-0" />
              )}
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-slate-400">
          Demand consumes stock, the reorder rule is checked against stock plus
          everything already on order, a purchase order is created when needed, and
          it arrives after the supplier lead time.
        </p>
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          The reorder rule is the same one the live recommendation uses:{' '}
          {REPLENISHMENT_RULE}
        </p>
      </Card>

      {/* Model evaluation, collapsed. A customer deciding on inventory does not
          need to read it, and EcomAI-OS — not the user — chooses the forecast
          model, so it is not a decision on this page. */}
      <div className="card overflow-hidden">
        <button
          type="button"
          onClick={() => setModelOpen((open) => !open)}
          aria-expanded={modelOpen}
          aria-controls="model-details-panel"
          className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
        >
          <span>
            <span className="block text-sm font-bold text-slate-900">
              Forecast model evaluation
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              {results.modelDetails.note}
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${
              modelOpen ? 'rotate-180' : ''
            }`}
          />
        </button>
        {modelOpen && (
          <div id="model-details-panel" className="border-t border-slate-100 px-5 py-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80">
                    <th className="table-th">Forecast method</th>
                    <th className="table-th text-right">Stockouts</th>
                    <th className="table-th text-right">Service level</th>
                    <th className="table-th text-right">Avg inventory</th>
                    <th className="table-th text-right">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.modelDetails.methods.map((method) => (
                    <tr key={method.key}>
                      <td className="table-td">
                        <span className="block text-sm font-semibold text-slate-800">
                          {method.label}
                        </span>
                        <span className="block text-xs text-slate-400">
                          {method.description}
                        </span>
                      </td>
                      <td className="table-td tnum text-right text-slate-600">
                        {plural(method.stockoutDays, 'day')}
                      </td>
                      <td className="table-td tnum text-right text-slate-600">
                        {method.serviceLevel}%
                      </td>
                      <td className="table-td tnum text-right text-slate-600">
                        {formatNumber(Math.round(method.averageInventory))} units
                      </td>
                      <td className="table-td tnum text-right text-slate-600">
                        {formatINR(method.inventoryCost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              {results.modelDetails.meaning}
            </p>
          </div>
        )}
      </div>

      <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {results.disclaimer}
      </p>
    </div>
  );
}
