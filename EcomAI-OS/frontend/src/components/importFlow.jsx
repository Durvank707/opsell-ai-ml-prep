// Reusable presentational pieces of the CSV upload flows (sales & products).
// The step indicator, the progress placeholder, the import summary stats and
// the error list are identical between the two flows, so they live here and
// each page supplies only the data.

import React from 'react';
import { CheckCircle2, FileSpreadsheet } from 'lucide-react';
import { cn, formatNumber } from '../lib/utils';

export const IMPORT_STEPS = [
  { key: 'choose', label: 'Choose File' },
  { key: 'upload', label: 'Upload' },
  { key: 'validate', label: 'Validate' },
  { key: 'import', label: 'Import' },
];

export function ImportStepsIndicator({ steps = IMPORT_STEPS, stepIndex, phase, className }) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {steps.map((s, i) => (
        <React.Fragment key={s.key}>
          <span
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold',
              stepIndex > i || (phase === 'done' && i === steps.length - 1)
                ? 'bg-emerald-100 text-emerald-700'
                : stepIndex === i && phase !== 'done'
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-400',
            )}
          >
            {stepIndex > i || (phase === 'done' && i === steps.length - 1) ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              i + 1
            )}
          </span>
          {i < steps.length - 1 && <span className="h-px w-4 bg-slate-200 sm:w-6" />}
        </React.Fragment>
      ))}
    </div>
  );
}

export function UploadPhase({ icon: Icon, title, subtitle, loading }) {
  return (
    <div className="flex flex-col items-center py-10 text-center">
      {loading ? (
        <span className="h-8 w-8 animate-spin rounded-full border-3 border-slate-200 border-t-brand-600" />
      ) : (
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <Icon className="h-5 w-5" />
        </span>
      )}
      <p className="mt-4 text-sm font-bold text-slate-800">{title}</p>
      <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
    </div>
  );
}

export function ImportStats({ validation }) {
  const items = [
    { label: 'Total rows', value: formatNumber(validation.totalRows), tone: 'text-slate-800' },
    { label: 'Valid rows', value: formatNumber(validation.validRows), tone: 'text-emerald-700' },
    { label: 'Skipped rows', value: formatNumber(validation.skippedRows), tone: validation.skippedRows ? 'text-amber-700' : 'text-slate-400' },
  ];
  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map((i) => (
        <div key={i.label} className="rounded-xl bg-slate-50 p-3 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{i.label}</p>
          <p className={cn('tnum mt-1 text-lg font-extrabold', i.tone)}>{i.value}</p>
        </div>
      ))}
    </div>
  );
}

export function ErrorsList({ validation, showErrors, setShowErrors }) {
  const visible = showErrors ? validation.errors : validation.errors.slice(0, 5);
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40">
      <div className="flex items-center justify-between border-b border-amber-200/60 px-4 py-2.5">
        <p className="flex items-center gap-1.5 text-xs font-bold text-amber-700">
          <FileSpreadsheet className="h-3.5 w-3.5" />
          {validation.errors.length} invalid {validation.errors.length === 1 ? 'row' : 'rows'}
        </p>
        <button
          onClick={() => setShowErrors((s) => !s)}
          className="text-[11px] font-semibold text-amber-600 hover:text-amber-800"
        >
          {showErrors ? 'Show fewer' : `Show all (${validation.errors.length})`}
        </button>
      </div>
      <ul className="max-h-44 overflow-y-auto px-4 py-2">
        {visible.map((e, i) => (
          <li key={i} className="flex items-start gap-2 border-b border-amber-100 py-1.5 last:border-0">
            <span className="tnum shrink-0 font-mono text-[10px] font-bold text-amber-500">L{e.row}</span>
            <span className="text-xs text-slate-600">{e.reason}</span>
          </li>
        ))}
      </ul>
      <div className="px-4 py-2.5 pb-3">
        <p className="text-[11px] text-amber-700">
          Fix these rows in your file and re-upload. You can also download the template to match the expected format.
        </p>
      </div>
    </div>
  );
}