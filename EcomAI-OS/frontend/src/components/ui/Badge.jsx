import React from 'react';
import { cn } from '../../lib/utils';

export function Badge({ children, tone = 'neutral', dot = false, className }) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-600 border-slate-200',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-rose-50 text-rose-700 border-rose-200',
    blue: 'bg-sky-50 text-sky-700 border-sky-200',
    indigo: 'bg-brand-50 text-brand-700 border-brand-200',
    gray: 'bg-slate-50 text-slate-500 border-slate-200',
  };
  const dots = {
    neutral: 'bg-slate-400',
    green: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-rose-500',
    blue: 'bg-sky-500',
    indigo: 'bg-brand-500',
    gray: 'bg-slate-400',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dots[tone])} />}
      {children}
    </span>
  );
}

const STATUS_MAP = {
  healthy: { tone: 'green', label: 'Healthy' },
  low: { tone: 'amber', label: 'Low Stock' },
  critical: { tone: 'red', label: 'Critical' },
  overstocked: { tone: 'blue', label: 'Overstocked' },
};

/** Semantic stock status badge. */
export function StatusBadge({ status, className }) {
  const cfg = STATUS_MAP[status] || { tone: 'neutral', label: status };
  return (
    <Badge tone={cfg.tone} dot className={className}>
      {cfg.label}
    </Badge>
  );
}

export function RiskBadge({ level }) {
  if (level === 'HIGH' || level === 'critical')
    return <Badge tone="red" dot>Critical</Badge>;
  if (level === 'MEDIUM' || level === 'low')
    return <Badge tone="amber" dot>At Risk</Badge>;
  return <Badge tone="green" dot>Healthy</Badge>;
}

export function TrendIndicator({ trend, className }) {
  const map = {
    increasing: { label: '↑ Increasing', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    decreasing: { label: '↓ Decreasing', cls: 'text-rose-700 bg-rose-50 border-rose-200' },
    stable: { label: '→ Stable', cls: 'text-slate-600 bg-slate-100 border-slate-200' },
  };
  const cfg = map[trend] || map.stable;
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold', cfg.cls, className)}>
      {cfg.label}
    </span>
  );
}

export const SEVERITY_TONE = {
  info: 'blue',
  success: 'green',
  warning: 'amber',
  critical: 'red',
};

export function SeverityBadge({ severity, label }) {
  return <Badge tone={SEVERITY_TONE[severity] || 'neutral'}>{label || severity}</Badge>;
}