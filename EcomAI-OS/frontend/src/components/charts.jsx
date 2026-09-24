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
  Legend,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  LineChart,
  ReferenceLine,
} from 'recharts';
import { formatNumber } from '../lib/utils';

// Shared chart theming -------------------------------------------------------

const AXIS_TICK = { fontSize: 11, fill: '#64748b' };
const GRID = { stroke: '#e2e8f0', strokeDasharray: '3 3', vertical: false };

export const ACTUAL_COLOR = '#334155';
export const FORECAST_COLOR = '#4f46e5';
export const BAND_COLOR = '#818cf8';

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
          <CartesianGrid {...GRID} />
          <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} minTickGap={28} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTip formatter={formatter} />} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="plainline" />
          {showBand && forecast.length > 0 && (
            <>
              <Area
                type="monotone"
                dataKey="upper"
                name="Upper Bound"
                stroke="none"
                fill={BAND_COLOR}
                fillOpacity={0.12}
              />
              <Area
                type="monotone"
                dataKey="lower"
                name="Lower Bound"
                stroke="none"
                fill="rgba(255,255,255,0)"
              />
            </>
          )}
          <Line
            type="monotone"
            dataKey="Actual Demand"
            stroke={ACTUAL_COLOR}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="Forecast Demand"
            stroke={FORECAST_COLOR}
            strokeWidth={2}
            strokeDasharray="6 3"
            dot={false}
            activeDot={{ r: 3 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
      {footer && <div className="mt-2">{footer}</div>}
    </div>
  );
}

// Inventory health donut ----------------------------------------------------

export function HealthDonut({ healthy, atRisk, critical, size = 180 }) {
  const data = [
    { name: 'Healthy', value: healthy, color: '#10b981' },
    { name: 'At Risk', value: atRisk, color: '#f59e0b' },
    { name: 'Critical', value: critical, color: '#f43f5e' },
  ].filter((d) => d.value > 0);
  const total = healthy + atRisk + critical;

  const legend = [
    { label: 'Healthy', value: healthy, color: '#10b981' },
    { label: 'At Risk', value: atRisk, color: '#f59e0b' },
    { label: 'Critical', value: critical, color: '#f43f5e' },
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

export function StockLineChart({ points, height = 260, reference = null, formatter }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} minTickGap={30} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <Tooltip content={<ChartTip formatter={formatter} />} />
        <Line
          type="monotone"
          dataKey="stock"
          name="Stock level"
          stroke={FORECAST_COLOR}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3 }}
        />
        {reference !== null && (
          <ReferenceLine y={reference} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: 'Reorder point', fontSize: 10, fill: '#b45309', position: 'insideBottomRight' }} />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

// Simple bars (used for channel/period breakdowns) ---------------------------

export function SimpleBars({ data, dataKey = 'value', nameKey = 'name', height = 220, color = '#4f46e5' }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey={nameKey} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <Tooltip content={<ChartTip />} />
        <Bar dataKey={dataKey} fill={color} radius={[4, 4, 0, 0]} maxBarSize={42} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export { ChartTip };