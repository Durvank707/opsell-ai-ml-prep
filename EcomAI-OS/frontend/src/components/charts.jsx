import React from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  LineChart,
  ReferenceLine,
} from 'recharts';
import { formatNumber } from '../lib/utils';
import { useChartTokens } from '../theme/chartTokens';

// Shared chart theming -------------------------------------------------------
//
// Colours come from the theme rather than being written into each chart, so the
// axis text, grid lines, series and warning markers all stay legible in the dark
// theme without a per-theme branch anywhere below. See src/theme/chartTokens.js.

function useChartTheme() {
  const t = useChartTokens();
  return {
    ...t,
    axisTick: { fontSize: 11, fill: t.axis },
    axisLine: { stroke: t.grid },
    grid: { stroke: t.grid, strokeDasharray: '3 3', vertical: false },
  };
}

/**
 * A legend drawn from the series the chart is about to paint.
 *
 * recharts' own Legend takes each label's colour from the series it belongs to,
 * which conflates two different things: the band is filled in a light indigo, so
 * its label was rendered in that same light indigo - readable on white, not on a
 * dark surface. Listing the series here keeps the swatch tied to the series
 * colour while the label follows the theme's text, which is what makes the
 * legend readable in both.
 */
function ChartLegend({ entries }) {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-2 text-[11px]">
      {entries.map((entry) => (
        <li key={entry.label} className="flex items-center gap-1.5 text-slate-500">
          <span className="h-0.5 w-4 rounded-full" style={{ background: entry.color }} aria-hidden />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

function ChartTip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  const fmt = formatter || ((v) => formatNumber(v));
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-pop">
      <p className="mb-1 text-[11px] font-bold text-slate-500">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className="flex items-center gap-2 text-xs text-slate-600">
          <span className="h-2 w-2 rounded-full" style={{ background: entry.color || entry.stroke }} />
          <span className="font-medium">{entry.name}:</span>
          <span className="tnum font-bold text-slate-900">{fmt(entry.value, entry)}</span>
        </p>
      ))}
    </div>
  );
}

// Actual vs Forecast demand -----------------------------------------------

export function DemandChart({
  actuals = [],
  forecast = [],
  height = 300,
  showBand = true,
  formatter,
  footer,
}) {
  const c = useChartTheme();
  const combined = [
    ...actuals.map((a) => ({ date: a.date, 'Actual Demand': a.units })),
    ...forecast.map((f) => ({
      date: f.date,
      'Forecast Demand': f.forecast,
      lower: f.lower,
      upper: f.upper,
    })),
  ];

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={combined} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid {...c.grid} />
          <XAxis dataKey="date" tick={c.axisTick} tickLine={false} axisLine={c.axisLine} minTickGap={28} />
          <YAxis tick={c.axisTick} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTip formatter={formatter} />} />
          {showBand && forecast.length > 0 && (
            <>
              <Area
                type="monotone"
                dataKey="upper"
                name="Upper Bound"
                stroke="none"
                fill={c.band}
                fillOpacity={0.12}
              />
              <Area
                type="monotone"
                dataKey="lower"
                name="Lower Bound"
                stroke="none"
                // Painted by the Area above, so this one contributes nothing to
                // the plot - the pair of Areas is how recharts draws a band
                // between two bounds. The legend above names the band once
                // rather than listing two half-empty entries.
                fill="transparent"
              />
            </>
          )}
          <Line
            type="monotone"
            dataKey="Actual Demand"
            stroke={c.actual}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="Forecast Demand"
            stroke={c.forecast}
            strokeWidth={2}
            strokeDasharray="6 3"
            dot={false}
            activeDot={{ r: 3 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <ChartLegend
        entries={[
          ...(showBand && forecast.length > 0
            ? [{ label: 'Confidence band', color: c.band }]
            : []),
          { label: 'Actual demand', color: c.actual },
          { label: 'Forecast demand', color: c.forecast },
        ]}
      />
      {footer && <div className="mt-2">{footer}</div>}
    </div>
  );
}

// Inventory health donut ----------------------------------------------------

export function HealthDonut({ healthy, atRisk, critical, size = 180 }) {
  const c = useChartTheme();
  const data = [
    { name: 'Healthy', value: healthy, color: c.healthy },
    { name: 'At Risk', value: atRisk, color: c.risk },
    { name: 'Critical', value: critical, color: c.critical },
  ].filter((d) => d.value > 0);
  const total = healthy + atRisk + critical;

  const legend = [
    { label: 'Healthy', value: healthy, color: c.healthy },
    { label: 'At Risk', value: atRisk, color: c.risk },
    { label: 'Critical', value: critical, color: c.critical },
  ];

  return (
    <div className="flex flex-wrap items-center justify-center gap-6">
      <div className="relative" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="68%"
              outerRadius="92%"
              paddingAngle={3}
              strokeWidth={0}
            >
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip content={<ChartTip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="tnum text-2xl font-extrabold text-slate-900">{total}</span>
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">SKUs</span>
        </div>
      </div>
      <div className="space-y-2.5">
        {legend.map((l) => (
          <div key={l.label} className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />
            <span className="text-sm text-slate-600">{l.label}</span>
            <span className="tnum ml-auto pl-4 text-sm font-bold text-slate-900">
              {l.value}
              <span className="ml-1 font-medium text-slate-400">
                ({total ? Math.round((l.value / total) * 100) : 0}%)
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Stock over time (inventory timeline) --------------------------------------

/**
 * Stock on hand across the days, with the reorder level as a reference.
 *
 * The plain version plots the stock line and nothing else, which is what the
 * product page wants. Passing `inTransitKey` adds the units already bought but
 * not yet delivered, and `lostKey` marks the days demand could not be met — the
 * simulation needs both to be readable, because without them a dip in stock
 * looks like a strategy that stopped ordering and an empty day looks like a
 * rounding error.
 */
export function StockLineChart({
  points,
  height = 260,
  reference = null,
  formatter,
  inTransitKey = null,
  lostKey = null,
}) {
  const c = useChartTheme();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid {...c.grid} />
        <XAxis dataKey="date" tick={c.axisTick} tickLine={false} axisLine={c.axisLine} minTickGap={30} />
        <YAxis tick={c.axisTick} tickLine={false} axisLine={false} />
        <Tooltip content={<ChartTip formatter={formatter} />} />
        {inTransitKey && (
          <Area
            type="monotone"
            dataKey={inTransitKey}
            name="In transit"
            stroke="none"
            fill={c.band}
            fillOpacity={0.18}
            stackId="none"
          />
        )}
        <Line
          type="monotone"
          dataKey="stock"
          name="Stock level"
          stroke={c.forecast}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3 }}
        />
        {lostKey && (
          <Line
            type="stepAfter"
            dataKey={lostKey}
            name="Demand not met"
            stroke={c.lost}
            strokeWidth={1.5}
            strokeDasharray="3 3"
            dot={false}
            activeDot={{ r: 3 }}
          />
        )}
        {reference !== null && (
          <ReferenceLine y={reference} stroke={c.reorder} strokeDasharray="4 4" label={{ value: 'Reorder point', fontSize: 10, fill: c.reorderLabel, position: 'insideBottomRight' }} />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

// Simple bars (used for channel/period breakdowns) ---------------------------

export function SimpleBars({ data, dataKey = 'value', nameKey = 'name', height = 220, color }) {
  const c = useChartTheme();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid {...c.grid} />
        <XAxis dataKey={nameKey} tick={c.axisTick} tickLine={false} axisLine={c.axisLine} />
        <YAxis tick={c.axisTick} tickLine={false} axisLine={false} />
        <Tooltip content={<ChartTip />} />
        <Bar dataKey={dataKey} fill={color || c.bar} radius={[4, 4, 0, 0]} maxBarSize={42} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export { ChartTip };
