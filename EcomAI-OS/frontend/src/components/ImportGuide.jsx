// "Before you upload" guide shown on the Sales and Products import screens.
//
// It states the EXACT required/optional columns each importer accepts, with a
// one-line meaning per column, so a new tenant knows what to prepare before
// uploading. The Sales variant adds the "How forecasting works" explainer whose
// claims are pinned to the serving pipeline by
// tests/test_onboarding_templates.py (lags, rolling demand statistics and
// calendar information are the features `forecast_product_demand` derives).

import React from 'react';
import { FileSpreadsheet, Sparkles, CheckCircle2 } from 'lucide-react';
import { cn } from '../lib/utils';

const REQUIRED_MARK = (
  <span className="rounded-full bg-brand-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-brand-700">
    Required
  </span>
);

const OPTIONAL_MARK = (
  <span className="rounded-full bg-slate-200 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-slate-500">
    Optional
  </span>
);

// The required/optional split mirrors the canonical contracts in
// backend/contracts.py (PRODUCT_RECORD / SALES_RECORD).
const COLUMN_GUIDES = {
  sales: {
    required: [
      ['date', 'Calendar day of the sale, as YYYY-MM-DD.'],
      ['product_id', 'Your product ID — the product must already be in your catalog.'],
      ['units_sold', 'Whole-number count of units sold. Zero is valid demand.'],
    ],
    optional: [
      ['price', 'Unit price for the row. Falls back to the product’s catalog price when missing.'],
      ['category', 'Product category — the forecasting gate checks it before using the trained model.'],
      ['promotion', '0 or 1 — whether the sale ran on promotion. Defaults to no promotion when missing.'],
      ['channel', 'Selling channel (e.g. “Online Store”, “Amazon”). Free-form; demand is forecast on the product’s combined daily units.'],
    ],
  },
  product: {
    required: [
      ['product_id', 'A unique ID for the product.'],
      ['product_name', 'Display name for the product.'],
      ['current_stock', 'Physical on-hand stock in units.'],
    ],
    optional: [
      ['category', 'Product category — used by the forecasting eligibility gate.'],
      ['open_order_qty', 'Units already on order (open purchase orders).'],
      ['expected_arrival_date', 'Next arrival date, as YYYY-MM-DD.'],
      ['lead_time_days', 'Supplier lead time in days. Defaults to 7 when missing.'],
      ['unit_cost', 'Unit cost (used for inventory value and financial metrics).'],
      ['safety_stock', 'Extra buffer stock to keep beyond lead-time demand.'],
      ['reorder_point', 'Manual reorder point override when you manage it yourself.'],
      ['unit_price', 'Catalog selling price. Used when a sales row carries none.'],
      ['supplier', 'Display-only supplier label.'],
      ['description', 'Display-only product description.'],
      ['forecast_error_std', 'Optional per-product demand error, if you have one.'],
    ],
  },
};

function ColumnGroup({ title, mark, columns }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{title}</p>
      <ul className="mt-1.5 space-y-1">
        {columns.map(([name, meaning]) => (
          <li key={name} className="flex items-baseline gap-2 text-xs">
            <code className="shrink-0 rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200">
              {name}
            </code>
            <span className="text-slate-500">{meaning}</span>
            <span className="ml-auto shrink-0">{mark}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeatureEngineeringNote() {
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-4">
      <p className="flex items-center gap-1.5 text-xs font-bold text-violet-800">
        <Sparkles className="h-3.5 w-3.5" /> How forecasting works
      </p>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">
        You provide your normal business data. EcomAI-OS automatically creates the
        forecasting features required by the ML model — previous-day sales,
        weekly history, rolling demand statistics, and calendar information —
        from your product IDs, dates and units sold. You never need to add a
        model column yourself.
      </p>
      <ul className="mt-2.5 grid gap-1 text-[11px] text-slate-500 sm:grid-cols-2">
        <li><Feature label="Previous-day & weekly history" detail="demand from the last 1, 7, 14 and 28 days" /></li>
        <li><Feature label="Rolling demand statistics" detail="recent moving averages and variability" /></li>
        <li><Feature label="Calendar information" detail="day of week, month and weekend flags" /></li>
      </ul>
      <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
        The model needs at least 90 days of history per product before it is
        used. Below that, EcomAI-OS still forecasts with a transparent baseline
        and tells you it did. More history — the model prefers a year or more —
        improves the forecast.
      </p>
    </div>
  );
}

function Feature({ label, detail }) {
  return (
    <span className="flex items-start gap-1.5">
      <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-violet-500" />
      <span>
        <span className="font-semibold text-slate-600">{label}</span>{' '}
        <span className="text-slate-400">— {detail}</span>
      </span>
    </span>
  );
}

export default function ImportGuide({ recordType = 'sales', className }) {
  const guide = COLUMN_GUIDES[recordType] || COLUMN_GUIDES.sales;
  return (
    <div className={cn('rounded-2xl border border-slate-200 bg-slate-50/50 p-4 text-left', className)}>
      <p className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
        <FileSpreadsheet className="h-4 w-4 text-brand-600" />
        Your CSV needs these columns
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Download the template below for exact column names and a format that
        imports cleanly. Anything you don’t fill in is handled explicitly, never
        guessed silently.
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <ColumnGroup title="Required" mark={REQUIRED_MARK} columns={guide.required} />
        <ColumnGroup title="Optional" mark={OPTIONAL_MARK} columns={guide.optional} />
      </div>
      {recordType === 'sales' && <div className="mt-4"><FeatureEngineeringNote /></div>}
    </div>
  );
}