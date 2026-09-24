import React, { useEffect } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/utils';
import Button from './Button';

function ModalShell({ open, onClose, children, width = 'max-w-lg' }) {
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', handler);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative w-full rounded-t-2xl sm:rounded-2xl bg-white shadow-pop border border-slate-200 animate-slide-up max-h-[92vh] flex flex-col',
          width,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export default function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width,
}) {
  return (
    <ModalShell open={open} onClose={onClose} width={width}>
      {(title || description) && (
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
      )}
      <div className="overflow-y-auto px-5 py-4">{children}</div>
      {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3.5">{footer}</footer>}
    </ModalShell>
  );
}

/** Confirmation dialog (used for logout / delete / destructive actions). */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  danger = true,
  loading = false,
  children,
}) {
  return (
    <ModalShell open={open} onClose={onClose} width="max-w-sm">
      <div className="p-5">
        <div
          className={cn(
            'mx-auto flex h-11 w-11 items-center justify-center rounded-full',
            danger ? 'bg-rose-50 text-rose-600' : 'bg-brand-50 text-brand-600',
          )}
        >
          <AlertTriangle className="h-5 w-5" />
        </div>
        <h2 className="mt-3 text-center text-base font-bold text-slate-900">{title}</h2>
        {message && <p className="mt-1.5 text-center text-sm text-slate-500">{message}</p>}
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-5 flex justify-center gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}