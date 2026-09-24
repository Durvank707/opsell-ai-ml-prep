import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, Info, Sparkles, Package, ArrowUpRight, ArrowDownRight, AlertTriangle } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { TrendIndicator } from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { SearchInput, Select } from '../components/ui/form';
import { LoadingSkeleton, SkeletonChart } from '../components/ui/Skeleton';
import { DemandChart } from '../components/charts';
import { getForecastOverview, generatePortfolioForecast } from '../services/forecastService';
import { useAuth } from '../context/AuthContext';
import { useData } from '../context/DataContext';
import { useToast } from '../context/ToastContext';
import { formatNumber, cn } from '../lib/utils';

const HORIZONS = [7, 30, 90];

export default function ForecastPage() {
  const { user } = useAuth();
  const { refresh } = useData();
  const toast = useToast();
  const navigate = useNavigate();

  const [horizon, setHorizon] = useState(30);
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [showHow, setShowHow] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getForecastOverview(user, { horizon, category: category === 'all' ? null : category });
      // apply client-side search filter to rows
      if (search.trim()) {
        const q = search.toLowerCase();
        data.rows = data.rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
      }
      setOverview(data);
      setError('');
    } catch (e) {
      setError(e.message || 'Unable to load the forecast. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, horizon, category, search]);

  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await generatePortfolioForecast(user);
      refresh();
      toast.success(`Forecast generated for ${res.products} products.`);
    } catch (e) {
      toast.error(e.message || 'Unable to generate the forecast.');
    } finally {
      setGenerating(false);
    }
  };

  const metricsCards = useMemo(() => {
    if (!overview) return [];
    const m = overview.metrics;
    return [
      { label: 'Expected Daily Demand', value: formatNumber(m.avgExpectedDemand), sub: 'Units per day (portfolio avg)', icon: Package },
      { label: 'Forecast Total', value: formatNumber(m.totalForecastUnits), sub: `Projected for next ${horizon} days`, icon: TrendingUp },
      { label: 'Trending Up', value: m.growing != null ? formatNumber(m.growing) : (overview.metrics.growthPct > 0 ? '↑' : '—'), sub: 'Products with rising demand', icon: ArrowUpRight },
      { label: 'Trending Down', value: m.decreasing != null ? formatNumber(m.decreasing) : '—', sub: 'Products with falling demand', icon: ArrowDownRight },
    ];
  }, [overview, horizon]);

  if (loading && !overview) {
    return (
      <div className="space-y-5">
        <LoadingSkeleton rows={2} />
        <SkeletonChart />
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="space-y-5">
        <PageHeader title="Forecast" subtitle="AI demand forecast across your catalog." />
        <Card className="py-16">
          <EmptyState
            icon={AlertTriangle}
            title="Forecast unavailable"
            description={error}
            actionLabel="Back to Sales Data"
            onAction={() => navigate('/app/sales')}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Demand Forecast"
        subtitle="AI-powered demand projections across your inventory."
        actions={
          <Button icon={Sparkles} loading={generating} onClick={handleGenerate}>
            Generate Forecast
          </Button>
        }
      />

      {/* Controls */}
      <Card bodyClassName="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
            {HORIZONS.map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                  horizon === h ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100',
                )}
              >
                {h} Days
              </button>
            ))}
          </div>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full sm:w-44">
            <option value="all">All Categories</option>
            <option value="Electronics">Electronics</option>
            <option value="Accessories">Accessories</option>
            <option value="Audio">Audio</option>
            <option value="Wearables">Wearables</option>
            <option value="Home & Kitchen">Home & Kitchen</option>
            <option value="Gaming">Gaming</option>
            <option value="Office">Office</option>
            <option value="Mobile">Mobile</option>
          </Select>
          <SearchInput value={search} onChange={setSearch} placeholder="Search products…" className="w-full sm:w-56" />
          <button
            onClick={() => setShowHow((s) => !s)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            <Info className="h-3.5 w-3.5 text-brand-500" />
            How was this calculated?
          </button>
        </div>

        {showHow && overview && (
          <div className="mt-4 rounded-xl border border-brand-100 bg-brand-50/50 p-4 animate-fade-in">
            <p className="text-xs font-bold uppercase tracking-wide text-brand-700">Methodology</p>
            <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-slate-600">
              {overview.howCalculated.map((step, i) => (
                <li key={i} className="flex gap-2">
                  <span className="tnum shrink-0 font-bold text-brand-500">{i + 1}.</span>
                  {step}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* Metrics */}
      {overview && overview.metrics.totalForecastUnits > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            {metricsCards.map((m) => (
              <div key={m.label} className="card p-4">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                    <m.icon className="h-4 w-4" />
                  </span>
                  <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{m.label}</span>
                </div>
                <p className="tnum mt-3 text-2xl font-extrabold text-slate-900">{m.value}</p>
                <p className="mt-0.5 text-xs text-slate-400">{m.sub}</p>
              </div>
            ))}
          </div>

          {/* Chart */}
          <Card
            title={`Next ${horizon} Days — Demand Outlook`}
            subtitle="Historical sales vs AI forecast with confidence interval"
          >
            <DemandChart
              actuals={overview.chart.actuals.slice(-Math.max(horizon, 14))}
              forecast={overview.chart.forecast}
              height={300}
              formatter={(v) => formatNumber(v) + ' units'}
            />
            <p className="mt-3 border-t border-slate-100 pt-3 text-[11px] text-slate-400">
              Generated {overview.generatedAtLabel}. The shaded band represents the expected range for each day’s demand.
            </p>
          </Card>

          {/* Product rows */}
          <Card
            title="Forecast by Product"
            subtitle={`${overview.rows.length} products · projected ${horizon}-day demand`}
            bodyClassName="p-0"
            pad={false}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/80">
                    <th className="table-th">Product</th>
                    <th className="table-th">Category</th>
                    <th className="table-th text-right">Current Daily Avg</th>
                    <th className="table-th text-right">Projected {horizon}d</th>
                    <th className="table-th text-right">Change</th>
                    <th className="table-th">Trend</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {overview.rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => navigate(`/app/products/${r.id}`)}
                      className="cursor-pointer transition-colors hover:bg-slate-50"
                    >
                      <td className="table-td">
                        <p className="text-sm font-bold text-slate-800">{r.name}</p>
                        <p className="font-mono text-[11px] text-slate-400">{r.id}</p>
                      </td>
                      <td className="table-td"><span className="text-xs text-slate-500">{r.category}</span></td>
                      <td className="table-td text-right tnum text-slate-600">{formatNumber(r.current)}</td>
                      <td className="table-td text-right tnum font-bold text-slate-800">{formatNumber(r.totalForecast)}</td>
                      <td className="table-td text-right">
                        <span
                          className={cn(
                            'tnum inline-flex items-center gap-0.5 text-xs font-bold',
                            r.changePct > 2 ? 'text-emerald-600' : r.changePct < -2 ? 'text-rose-600' : 'text-slate-500',
                          )}
                        >
                          {r.changePct > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                          {Math.abs(r.changePct).toFixed(1)}%
                        </span>
                      </td>
                      <td className="table-td">
                        <TrendIndicator trend={r.trend} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : (
        <Card className="py-16">
          <EmptyState
            icon={TrendingUp}
            title="No forecast available yet"
            description="Forecasts need at least 7 days of sales history per product. Upload sales data or add more products to generate your first forecast."
            actionLabel="Upload Sales Data"
            onAction={() => navigate('/app/sales')}
          />
        </Card>
      )}
    </div>
  );
}