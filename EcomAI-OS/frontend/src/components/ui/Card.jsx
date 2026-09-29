import React, { forwardRef } from 'react';
import { cn } from '../../lib/utils';

// A plain surface with an optional header. The ref goes on the root element so a
// page can scroll to a specific card — the sales page does that after an import
// so the records it just wrote come into view.
const Card = forwardRef(function Card(
  { title, subtitle, actions, children, className, bodyClassName, pad = true },
  ref,
) {
  return (
    <section className={cn('card', className)} ref={ref}>
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
});

export default Card;
