import React from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  PackageX,
  PackageSearch,
  IndianRupee,
  RefreshCw,
  Target,
} from 'lucide-react';
import Card from './ui/Card';
import Button from './ui/Button';
import KPICard from '../components/KPICard';
import { StockLineChart } from './charts';
import { formatINR, formatNumber, formatDate } from '../lib/utils';

function MetricValue({ row, idx }) {
  const val = row.values[idx];
  if (row.format === 'percent') return `${val}%`;
  if (row.format === 'currency') return formatINR(val);
  return formatNumber(val);
}

export default function SimulationResults({ results, onRunAnother }) {
  const { kpis, stockout, excess, chart, comparison, config, selectedPolicy } = results;
  const bestValues = comparison.rows.map((row) =>
    row.metric === 'Service Level'
      ? Math.max(...row.values)
      : Math.min(...row.values),
  );

  // Which policy column wins the most metrics (used to call out the best column).
  const scoreboard = comparison.labels.map((_, colIdx) =>
    comparison.rows.reduce((score, row, ri) => score + (row.values[colIdx] === bestValues[ri] ? 1 : 0), 0),
  );
  const bestColIndex = scoreboard.indexOf(Math.max(...scoreboard));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold tracking-tight text-slate-900">Simulation Results</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {config.start && (
              <>
                {formatDate(config.start)} → {formatDate(config.end)} · {config.productCount} products ·{' '}
                <span className="font-semibold text-brand-700">{selectedPolicy}</span>
              </>
            )}
          </p>
        </div>
        <Button variant="secondary" onClick={onRunAnother} icon={RefreshCw}>
          Run Another Simulation
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KPICard
          icon={ShieldCheck}
          label="Service Level"
          value={`${kpis.serviceLevel}%`}
          tone="green"
          status={kpis.serviceLevel >= 90 ? 'good' : kpis.serviceLevel >= 80 ? 'warn' : 'critical'}
          sub="Orders fulfilled from stock"
        />
        <KPICard
          icon={AlertTriangle}
          label="Stockout Events"
          value={formatNumber(kpis.stockoutEvents)}
          tone="amber"
          status={kpis.stockoutEvents === 0 ? 'good' : 'warn'}
          sub={`${formatNumber(kpis.stockoutUnits)} units lost`}
        />
        <KPICard
          icon={PackageX}
          label="Stockout Units"
          value={formatNumber(kpis.stockoutUnits)}
          tone="red"
          status={kpis.stockoutUnits === 0 ? 'good' : 'critical'}
          sub="Demand not fulfilled"
        />
        <KPICard
          icon={PackageSearch}
          label="Excess Inventory"
          value={formatNumber(kpis.excessInventory)}
          tone="blue"
          sub="Units above target stock"
        />
        <KPICard
          icon={IndianRupee}
          label="Inventory Cost"
          value={formatINR(kpis.inventoryCost)}
          tone="indigo"
          sub={`Holding ${formatINR(kpis.holdingCost)} · Orders ${formatINR(kpis.orderingCost)}`}
        />
      </div>

      {/* Performance chart */}
      <Card
        title="Inventory Level Over Time"
        subtitle="Aggregate portfolio stock position across the simulated period"
      >
        <StockLineChart
          points={chart}
          height={300}
          formatter={(v) => formatNumber(v) + ' units'}
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Stockout analysis */}
        <Card title="Stockout Analysis" subtitle="Where and how often demand was not met">
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <StatBlock label="Events" value={formatNumber(stockout.events)} />
              <StatBlock label="Products affected" value={formatNumber(stockout.productsAffected.length)} />
              <StatBlock label="Avg. duration" value={`${stockout.avgDuration} days`} />
            </div>
            {stockout.productsAffected.length === 0 ? (
              <p className="rounded-xl bg-emerald-50 px-4 py-6 text-center text-sm font-medium text-emerald-700">
                No stockouts occurred under this policy.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
                {stockout.productsAffected.map((p) => (
                  <li key={p.productId} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-sm font-semibold text-slate-700">{p.name}</span>
                    <span className="flex items-center gap-3 text-xs text-slate-500">
                      <span className="tnum">{p.stockoutEvents} events</span>
                      <span className="tnum font-bold text-rose-600">{formatNumber(p.stockoutUnits)} units</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {/* Excess analysis */}
        <Card title="Excess Inventory Analysis" subtitle="Capital locked in stock above target">
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <StatBlock label="Products with excess" value={formatNumber(excess.products.length)} />
              <StatBlock label="Avg. excess units" value={formatNumber(excess.avgExcess)} />
              <StatBlock label="Holding cost" value={formatINR(excess.holdingCost)} />
            </div>
            {excess.products.length === 0 ? (
              <p className="rounded-xl bg-emerald-50 px-4 py-6 text-center text-sm font-medium text-emerald-700">
                No material excess stock identified.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
                {excess.products.slice(0, 6).map((p) => (
                  <li key={p.productId} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-sm font-semibold text-slate-700">{p.name}</span>
                    <span className="tnum text-xs font-bold text-sky-600">{formatNumber(p.excessUnits)} units excess</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {/* Policy comparison */}
      <Card
        title="Policy Comparison"
        subtitle="How the standard inventory policies perform against the same historical demand"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="table-th">Metric</th>
                {comparison.labels.map((label, i) => (
                  <th key={label} className="table-th text-right">
                    <span className="inline-flex items-center gap-1.5">
                      {i === bestColIndex && <Target className="h-3 w-3 text-brand-600" />}
                      {label}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {comparison.rows.map((row, ri) => (
                <tr key={row.metric}>
                  <td className="table-td font-semibold text-slate-800">{row.metric}</td>
                  {row.values.map((v, vi) => (
                    <td
                      key={vi}
                      className={`table-td text-right tnum ${
                        v === bestValues[ri] ? 'font-bold text-brand-700' : 'text-slate-600'
                      }`}
                    >
                      <MetricValue row={row} idx={vi} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Best value per metric is highlighted. Lower is better for stockouts, excess and cost; higher is better for service level.
        </p>
      </Card>
    </div>
  );
}

function StatBlock({ label, value }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 text-center">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="tnum mt-1 text-base font-extrabold text-slate-800">{value}</p>
    </div>
  );
}