import React from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { cn } from '../lib/utils';

const ICON_TONES = {
  indigo: 'bg-brand-50 text-brand-600',
  green: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  red: 'bg-rose-50 text-rose-600',
  slate: 'bg-slate-100 text-slate-500',
  blue: 'bg-sky-50 text-sky-600',
};

export default function KPICard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'indigo',
  change = null,
  changeDirection = 'up', // 'up' | 'down'
  status = null, // 'good' | 'warn' | 'critical'
  prefix = null,
}) {
  const statusDot = {
    good: 'bg-emerald-500',
    warn: 'bg-amber-500',
    critical: 'bg-rose-500',
  };
  return (
    <div className="card relative p-5">
      <div className="flex items-start justify-between">
        <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl', ICON_TONES[tone])}>
          <Icon className="h-5 w-5" />
        </span>
        {status && <span className={cn('mt-1 h-2.5 w-2.5 rounded-full', statusDot[status])} />}
      </div>
      <p className="mt-4 text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="tnum mt-1 flex items-baseline gap-1.5 text-[26px] font-extrabold leading-none tracking-tight text-slate-900">
        {prefix && <span className="text-lg font-bold text-slate-400">{prefix}</span>}
        {value}
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        {sub && <p className="truncate text-xs text-slate-500">{sub}</p>}
        {change !== null && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-bold',
              changeDirection === 'up'
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-rose-50 text-rose-600',
            )}
          >
            {changeDirection === 'up' ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : (
              <ArrowDownRight className="h-3 w-3" />
            )}
            {Math.abs(change)}%
          </span>
        )}
      </div>
    </div>
  );
}