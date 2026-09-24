import React from 'react';
import { ArrowRight, AlertOctagon, PackagePlus, Eye, CheckCircle2, Package } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Button from './ui/Button';
import { cn } from '../lib/utils';

const TYPE_STYLES = {
  critical: {
    ring: 'ring-rose-100 border-rose-200',
    chip: 'bg-rose-50 text-rose-700 border-rose-200',
    icon: AlertOctagon,
    iconColor: 'text-rose-600',
    label: 'Critical',
  },
  reorder: {
    ring: 'ring-amber-100 border-amber-200',
    chip: 'bg-amber-50 text-amber-700 border-amber-200',
    icon: PackagePlus,
    iconColor: 'text-amber-600',
    label: 'Reorder',
  },
  monitor: {
    ring: 'ring-sky-100 border-sky-200',
    chip: 'bg-sky-50 text-sky-700 border-sky-200',
    icon: Eye,
    iconColor: 'text-sky-600',
    label: 'Monitor',
  },
  no_action: {
    ring: 'ring-slate-100 border-slate-200',
    chip: 'bg-slate-100 text-slate-600 border-slate-200',
    icon: CheckCircle2,
    iconColor: 'text-slate-500',
    label: 'No Action',
  },
};

export default function RecommendationCard({ recommendation, onNavigate }) {
  const navigate = useNavigate();
  const cfg = TYPE_STYLES[recommendation.type] || TYPE_STYLES.no_action;
  const Icon = cfg.icon;
  const needOrder = recommendation.type === 'critical' || recommendation.type === 'reorder';

  return (
    <div className={cn('card flex flex-col p-5 ring-1', cfg.ring)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl', cfg.iconColor, 'bg-slate-50')}>
            <Icon className="h-5 w-5" />
          </span>
          <div>
            <span
              className={cn(
                'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                cfg.chip,
              )}
            >
              {needOrder ? `${cfg.label} · Order ${recommendation.recommendedOrder || 20} units` : cfg.label}
            </span>
            <h3 className="mt-1 text-sm font-bold text-slate-900">{recommendation.name}</h3>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 rounded-xl bg-slate-50 p-3 text-center">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">In stock</p>
          <p className="tnum mt-0.5 text-sm font-extrabold text-slate-800">{recommendation.currentStock}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Reorder pt.</p>
          <p className="tnum mt-0.5 text-sm font-extrabold text-slate-800">{recommendation.reorderPoint}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Lead-time demand</p>
          <p className="tnum mt-0.5 text-sm font-extrabold text-slate-800">{recommendation.projectedDemand}</p>
        </div>
      </div>

      <p className="mt-3.5 flex-1 text-sm text-slate-600">{recommendation.reason}</p>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-slate-100 pt-3.5">
        <span className="flex items-center gap-1.5 text-xs text-slate-500">
          <Package className="h-3.5 w-3.5" />
          {needOrder ? (
            <>
              Expected order amount:
              <span className="font-bold text-slate-800">{recommendation.recommendedOrder || 20} units</span>
            </>
          ) : (
            'No immediate order required'
          )}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate(`/app/products/${recommendation.productId}`)}
        >
          View Product <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}