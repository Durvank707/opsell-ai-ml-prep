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

/**
 * The three counts an import is judged by.
 *
 * The sales flow answers "how many rows are in this file" (total / valid /
 * skipped). The product flow answers "what happened to my catalog", which is a
 * different question: a product the tenant already had is not a bad row, it is a
 * row that was deliberately left alone, and lumping it in with invalid rows
 * would make a correct import look broken. So the product variant counts what
 * each row did — added, already existed, or failed.
 */
export function ImportStats({ validation, variant = 'rows' }) {
  const items =
    variant === 'products'
      ? [
          {
            label: 'New products',
            value: formatNumber(validation.validRows),
            tone: 'text-emerald-700',
          },
          {
            label: 'Already existed',
            value: formatNumber(validation.summary?.existing ?? 0),
            tone: validation.summary?.existing ? 'text-amber-700' : 'text-slate-400',
          },
          {
            label: 'Failed',
            value: formatNumber(validation.skippedRows - (validation.summary?.existing ?? 0)),
            tone:
              validation.skippedRows - (validation.summary?.existing ?? 0)
                ? 'text-rose-700'
                : 'text-slate-400',
          },
        ]
      : [
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

/**
 * The rows the report did not accept, split by what actually happened.
 *
 * A product this tenant already has is not a bad row. The import left it alone
 * on purpose, and calling it invalid tells the tenant to fix it in their file —
 * advice that cannot be followed, because re-uploading the same file skips the
 * same product again. Those rows are listed separately, as skipped, and the
 * invalid rows keep the "fix your file" wording that does help.
 */
export function ErrorsList({ validation, showErrors, setShowErrors }) {
  const errors = validation.errors || [];
  const skipped = errors.filter((error) => error.category === 'existing_product');
  const invalid = errors.filter((error) => error.category !== 'existing_product');
  const visible = showErrors ? invalid : invalid.slice(0, 5);

  return (
    <div className="space-y-3">
      {skipped.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/40">
          <div className="border-b border-amber-200/60 px-4 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-bold text-amber-700">
              <FileSpreadsheet className="h-3.5 w-3.5" />
              {skipped.length} {skipped.length === 1 ? 'product' : 'products'} already in your catalog
            </p>
          </div>
          <ul className="max-h-32 overflow-y-auto px-4 py-2">
            {skipped.map((e, i) => (
              <li
                key={`skipped-${e.row}-${i}`}
                className="flex items-start gap-2 border-b border-amber-100 py-1.5 last:border-0"
              >
                <span className="tnum shrink-0 font-mono text-[10px] font-bold text-amber-500">L{e.row}</span>
                <span className="text-xs text-slate-600">{e.reason}</span>
              </li>
            ))}
          </ul>
          <div className="px-4 pb-3">
            <p className="text-[11px] text-amber-700">
              These rows were not imported, and the products they name were left exactly as they were. Edit a
              product on the catalog page to change it — re-uploading the same file will skip it again.
            </p>
          </div>
        </div>
      )}

      {invalid.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/40">
          <div className="flex items-center justify-between border-b border-amber-200/60 px-4 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-bold text-amber-700">
              <FileSpreadsheet className="h-3.5 w-3.5" />
              {invalid.length} invalid {invalid.length === 1 ? 'row' : 'rows'}
            </p>
            <button
              onClick={() => setShowErrors((s) => !s)}
              className="text-[11px] font-semibold text-amber-600 hover:text-amber-800"
            >
              {showErrors ? 'Show fewer' : `Show all (${invalid.length})`}
            </button>
          </div>
          <ul className="max-h-44 overflow-y-auto px-4 py-2">
            {visible.map((e, i) => (
              <li
                key={`invalid-${e.row}-${i}`}
                className="flex items-start gap-2 border-b border-amber-100 py-1.5 last:border-0"
              >
                <span className="tnum shrink-0 font-mono text-[10px] font-bold text-amber-500">L{e.row}</span>
                <span className="text-xs text-slate-600">{e.reason}</span>
              </li>
            ))}
          </ul>
          <div className="px-4 py-2.5 pb-3">
            <p className="text-[11px] text-amber-700">
              Fix these rows in your file and re-upload. You can also download the template to match the expected
              format.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}