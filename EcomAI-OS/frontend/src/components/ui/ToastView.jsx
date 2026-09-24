import React from 'react';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useToastState } from '../../context/ToastContext';
import { cn } from '../../lib/utils';

const STYLES = {
  success: { icon: CheckCircle2, cls: 'text-emerald-600', bg: 'bg-emerald-50' },
  error: { icon: AlertCircle, cls: 'text-rose-600', bg: 'bg-rose-50' },
  info: { icon: Info, cls: 'text-brand-600', bg: 'bg-brand-50' },
  warning: { icon: AlertTriangle, cls: 'text-amber-600', bg: 'bg-amber-50' },
};

export default function ToastView() {
  const { toasts, remove } = useToastState();
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2">
      {toasts.map((t) => {
        const cfg = STYLES[t.type] || STYLES.info;
        const Icon = cfg.icon;
        return (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-pop animate-slide-in-right',
            )}
          >
            <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', cfg.bg, cfg.cls)}>
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              {t.title && <p className="text-xs font-bold text-slate-800">{t.title}</p>}
              <p className="text-sm text-slate-600">{t.message}</p>
            </div>
            <button
              onClick={() => remove(t.id)}
              className="rounded p-1 text-slate-300 hover:text-slate-500"
              aria-label="Dismiss notification"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}