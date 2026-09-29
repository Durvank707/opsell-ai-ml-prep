import React from 'react';
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
} from 'lucide-react';
import Card from './ui/Card';
import Button from './ui/Button';
import { StockLineChart } from './charts';
import { formatINR, formatNumber, formatDate } from '../lib/utils';
import {
  FORECAST_COMPARISON_MEANING,
  POLICY_COMPARISON_NOTE,
  SIMULATION_STEPS,
} from '../services/simulationPolicy';

const plural = (count, word) =>
  `${formatNumber(count)} ${word}${count === 1 ? '' : 's'}`;

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

function ComparisonTable({ columns, rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/80">
            {columns.map((column, index) => (
              <th key={column} className={`table-th ${index === 0 ? '' : 'text-right'}`}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="table-td">
                <span className="block text-sm font-semibold text-slate-800">{row.label}</span>
                {row.sublabel && (
                  <span className="block text-xs text-slate-400">{row.sublabel}</span>
                )}
              </td>
              {row.values.map((value, index) => (
                <td key={index} className="table-td tnum text-right text-slate-600">
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SimulationResults({ results, onRunAnother }) {
  const { kpis, policy, summary, chart, policyComparison, forecastComparison } = results;
  const range =
    results.start && results.end
      ? `${formatDate(results.start)} → ${formatDate(results.end)}`
      : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-slate-900">
            Simulation Results
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {results.productName}
            {range ? ` · ${range}` : ''}
            {results.durationDays ? ` · ${plural(results.durationDays, 'day')}` : ''}
            {' · '}
            <span className="font-semibold text-brand-700">{policy.label}</span>
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

      {/* The verdict in one sentence, before any table. */}
      <Card>
        <p className="text-base font-semibold leading-relaxed text-slate-800">{summary}</p>
        <p className="mt-2 text-xs text-slate-500">
          {results.disclaimer} Effective policy: {results.policyHint}
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          icon={AlertTriangle}
          tone="bg-amber-50 text-amber-600"
          label="Stockout days"
          value={formatNumber(kpis.stockoutDays)}
          helper="Days when demand was larger than the stock available to fulfil it."
          detail={`${plural(kpis.stockoutUnits, 'unit')} of demand lost`}
        />
        <MetricCard
          icon={ShieldCheck}
          tone="bg-emerald-50 text-emerald-600"
          label="Service level"
          value={`${kpis.serviceLevel}%`}
          helper="Share of recorded demand that was fulfilled from stock, rather than lost."
        />
        <MetricCard
          icon={PackageSearch}
          tone="bg-sky-50 text-sky-600"
          label="Average inventory"
          value={formatNumber(kpis.averageInventory)}
          helper="Average units held in stock across every simulated day."
        />
        <MetricCard
          icon={Layers}
          tone="bg-brand-50 text-brand-600"
          label="Excess inventory"
          value={formatNumber(kpis.excessInventory)}
          helper="Average units held above the policy's own safety stock buffer, in units."
        />
        <MetricCard
          icon={ShoppingCart}
          tone="bg-indigo-50 text-indigo-600"
          label="Orders placed"
          value={formatNumber(kpis.orders)}
          helper="Purchase orders this policy would have placed over the period."
          detail={`${plural(kpis.unitsOrdered, 'unit')} ordered in total`}
        />
        <MetricCard
          icon={IndianRupee}
          tone="bg-rose-50 text-rose-600"
          label="Inventory cost"
          value={formatINR(kpis.inventoryCost)}
          helper="Holding cost, plus the fixed cost of each order, plus the margin lost to stockouts."
          detail={`Holding ${formatINR(kpis.holdingCost)} · Orders ${formatINR(
            kpis.orderingCost,
          )} · Stockouts ${formatINR(kpis.stockoutCost)}`}
        />
      </div>

      <Card
        title="Inventory level over time"
        subtitle={`${results.productName} stock position under ${policy.label}${
          policy.averageReorderPoint
            ? ` · reorder point about ${formatNumber(Math.round(policy.averageReorderPoint))} units`
            : ''
        }`}
      >
        <StockLineChart
          points={chart}
          height={300}
          reference={policy.averageReorderPoint ? Math.round(policy.averageReorderPoint) : null}
          formatter={(value) => `${formatNumber(value)} units`}
        />
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
          it arrives after the supplier lead time. The result is scored on the
          metrics above.
        </p>
      </Card>

      {/* Two separate comparisons, deliberately not merged: one varies the
          policy, the other varies the forecasting method. */}
      <Card
        title="Policy comparison"
        subtitle="The same product, the same demand, the same days — only the policy changes"
      >
        <ComparisonTable
          columns={['Policy', 'Stockouts', 'Service level', 'Avg inventory', 'Orders', 'Cost']}
          rows={policyComparison.map((row) => ({
            key: row.key,
            label: row.label,
            sublabel: `Safety stock ${formatNumber(Math.round(row.safetyStock))} units${
              row.coverageDays ? ` · covers ${row.coverageDays} days` : ''
            }`,
            values: [
              `${formatNumber(row.stockoutDays)} days`,
              `${row.serviceLevel}%`,
              `${formatNumber(Math.round(row.averageInventory))} units`,
              formatNumber(row.orders),
              formatINR(row.inventoryCost),
            ],
          }))}
        />
        <p className="mt-3 text-xs text-slate-400">{POLICY_COMPARISON_NOTE}</p>
      </Card>

      <Card
        title="Forecast comparison"
        subtitle="Which forecast performed better? Same product, same policy — only the demand forecast changes"
      >
        <ComparisonTable
          columns={['Forecast method', 'Stockouts', 'Service level', 'Avg inventory', 'Cost']}
          rows={forecastComparison.map((row) => ({
            key: row.key,
            label: row.label,
            sublabel: row.description,
            values: [
              `${formatNumber(row.stockoutDays)} days`,
              `${row.serviceLevel}%`,
              `${formatNumber(Math.round(row.averageInventory))} units`,
              formatINR(row.inventoryCost),
            ],
          }))}
        />
        <div className="mt-3 rounded-xl bg-slate-50 px-4 py-3">
          <p className="text-xs font-semibold text-slate-700">What this tells you</p>
          <p className="mt-1 text-xs text-slate-500">{FORECAST_COMPARISON_MEANING}</p>
        </div>
      </Card>
    </div>
  );
}
