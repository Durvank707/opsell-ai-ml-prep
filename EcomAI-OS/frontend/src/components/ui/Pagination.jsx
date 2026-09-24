import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Select } from './form';

export default function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span className="tnum">
          {from}–{to} of {total.toLocaleString('en-IN')}
        </span>
        <span className="hidden items-center gap-1.5 sm:flex">
          <span>Show</span>
          <Select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="h-7 w-auto py-0 pl-2 pr-6 text-xs"
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        {[...Array(Math.min(pages, 5))].map((_, i) => {
          const start = pages <= 5 ? 1 : Math.min(Math.max(page - 2, 1), pages - 4);
          const p = start + i;
          return (
            <button
              key={p}
              onClick={() => onPageChange(p)}
              className={cn(
                'h-8 w-8 rounded-lg text-xs font-semibold transition-colors',
                p === page ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {p}
            </button>
          );
        })}
        <button
          onClick={() => onPageChange(Math.min(pages, page + 1))}
          disabled={page >= pages}
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}