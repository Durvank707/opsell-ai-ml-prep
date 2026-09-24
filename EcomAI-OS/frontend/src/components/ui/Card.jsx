import React from 'react';
import { cn } from '../../lib/utils';

export default function Card({ title, subtitle, actions, children, className, bodyClassName, pad = true }) {
  return (
    <section className={cn('card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            {title && <h3 className="text-sm font-bold text-slate-900">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(pad && 'p-5', bodyClassName)}>{children}</div>
    </section>
  );
}