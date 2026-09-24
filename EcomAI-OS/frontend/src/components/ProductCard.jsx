import React from 'react';
import { PackageOpen, Eye, Pencil, Trash2 } from 'lucide-react';
import { StatusBadge } from './ui/Badge';
import { formatINR, formatDate, timeAgo } from '../lib/utils';

const CATEGORY_STYLES = {
  Electronics: 'bg-brand-50 text-brand-700',
  Accessories: 'bg-violet-50 text-violet-700',
  Audio: 'bg-cyan-50 text-cyan-700',
  Wearables: 'bg-emerald-50 text-emerald-700',
  'Home & Kitchen': 'bg-amber-50 text-amber-700',
  Gaming: 'bg-rose-50 text-rose-700',
  Office: 'bg-slate-100 text-slate-600',
  Mobile: 'bg-sky-50 text-sky-700',
};

export default function ProductCard({ product, onView, onEdit, onDelete }) {
  return (
    <div className="card group flex flex-col p-5 transition-shadow hover:shadow-card">
      <div className="flex items-start gap-4">
        {/* image placeholder */}
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
          <PackageOpen className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <button onClick={() => onView(product)} className="block text-left">
            <h3 className="truncate text-sm font-bold text-slate-900 group-hover:text-brand-700">
              {product.name}
            </h3>
          </button>
          <p className="mt-0.5 font-mono text-[11px] text-slate-400">{product.id}</p>
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${CATEGORY_STYLES[product.category] || 'bg-slate-100 text-slate-600'}`}
          >
            {product.category}
          </span>
        </div>
      </div>

      <div className="mt-4 flex items-end justify-between border-t border-slate-100 pt-3.5">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">In stock</p>
          <p className="tnum text-xl font-extrabold text-slate-900">
            {product.currentStock}
            <span className="ml-1 text-xs font-medium text-slate-400">units</span>
          </p>
        </div>
        <StatusBadge status={product.status} />
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
        <span>
          <span className="font-mono">{formatINR(product.unitCost)}</span> / unit
        </span>
        <span>Updated {timeAgo(product.updatedAt)}</span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-1.5">
        <button
          onClick={() => onView(product)}
          className="flex items-center justify-center gap-1 rounded-lg border border-slate-200 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          <Eye className="h-3.5 w-3.5" /> View
        </button>
        <button
          onClick={() => onEdit(product)}
          className="flex items-center justify-center gap-1 rounded-lg border border-slate-200 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
        <button
          onClick={() => onDelete(product)}
          className="flex items-center justify-center gap-1 rounded-lg border border-rose-200 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </div>
    </div>
  );
}