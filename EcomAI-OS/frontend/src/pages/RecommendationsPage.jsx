import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lightbulb, AlertOctagon, PackagePlus, Eye, CheckCircle2, Package, RefreshCw } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Card from '../components/ui/Card';
import RecommendationCard from '../components/RecommendationCard';
import EmptyState from '../components/ui/EmptyState';
import { LoadingSkeleton } from '../components/ui/Skeleton';
import { getRecommendations } from '../services/recommendationService';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { cn, formatNumber } from '../lib/utils';

const FILTERS = [
  { value: 'all', label: 'All', icon: Package },
  { value: 'critical', label: 'Critical', icon: AlertOctagon },
  { value: 'reorder', label: 'Reorder', icon: PackagePlus },
  { value: 'monitor', label: 'Monitor', icon: Eye },
  { value: 'no_action', label: 'No Action', icon: CheckCircle2 },
];

export default function RecommendationsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getRecommendations(user, { filter });
      setData(res);
    } catch {
      toast.error('Unable to load recommendations. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, filter, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const totalActionable = useMemo(() => {
    if (!data) return 0;
    return (data.counts?.critical || 0) + (data.counts?.reorder || 0);
  }, [data]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Recommendations"
        subtitle="Plain-language inventory actions prioritized by urgency."
      />

      {loading && !data ? (
        <LoadingSkeleton variant="cards" />
      ) : !data ? (
        <Card className="py-16">
          <EmptyState
            icon={Lightbulb}
            title="Couldn’t load recommendations"
            description="The last request to the server failed, so there is nothing to show. Nothing was lost — try again."
            actionLabel="Retry"
            actionIcon={RefreshCw}
            onAction={load}
          />
        </Card>
      ) : data.items.length === 0 ? (
        <Card className="py-16">
          <EmptyState
            icon={Lightbulb}
            title="Nothing to recommend"
            description="Once you add products and sales history, EcomAI-OS will suggest reorder and watch actions here."
            actionLabel="Add Products"
            onAction={() => navigate('/app/products')}
          />
        </Card>
      ) : (
        <>
          {/* Filter bar with counts */}
          <Card bodyClassName="p-4">
            <div className="flex flex-wrap items-center gap-2">
              {FILTERS.map((f) => {
                const count = data?.counts?.[f.value] ?? 0;
                return (
                  <button
                    key={f.value}
                    onClick={() => setFilter(f.value)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors',
                      filter === f.value
                        ? 'border-brand-600 bg-brand-600 text-white'
                        : 'border-slate-300 text-slate-600 hover:bg-slate-50',
                    )}
                  >
                    <f.icon className="h-3.5 w-3.5" />
                    {f.label}
                    <span
                      className={cn(
                        'tnum rounded-full px-1.5 text-[10px] font-bold',
                        filter === f.value ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500',
                      )}
                    >
                      {formatNumber(count)}
                    </span>
                  </button>
                );
              })}
              <div className="ml-auto hidden items-center gap-2 text-xs text-slate-500 md:flex">
                <AlertOctagon className="h-4 w-4 text-rose-500" />
                <span>
                  <span className="tnum font-bold text-slate-800">{formatNumber(totalActionable)}</span> actions need
                  attention
                </span>
              </div>
            </div>
          </Card>

          {/* Cards */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {data.items.map((r) => (
              <RecommendationCard key={r.id} recommendation={r} />
            ))}
          </div>

          {data.items.length > 0 && (
            <p className="text-center text-xs text-slate-400">
              Showing {formatNumber(data.items.length)} of {formatNumber(data.counts[filter] ?? 0)}{' '}
              {filter === 'all' ? 'recommendations' : `“${filter}” items`} · prioritized by urgency.
            </p>
          )}
        </>
      )}
    </div>
  );
}