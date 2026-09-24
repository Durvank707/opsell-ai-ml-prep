import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Pencil,
  Package,
  TrendingUp,
  ShieldAlert,
  ShieldCheck,
  Timer,
  ShoppingCart,
  Truck,
  AlertTriangle,
  IndianRupee,
  RefreshCw,
  CheckCircle2,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { StatusBadge, TrendIndicator } from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { LoadingSkeleton, SkeletonChart } from '../components/ui/Skeleton';
import { DemandChart, StockLineChart } from '../components/charts';
import { getProduct, getInventoryTimeline } from '../services/inventoryService';
import { getProductForecast } from '../services/forecastService';
import { placeSimulatedOrder } from '../services/settingsService';
import { useAuth } from '../context/AuthContext';
import { useData } from '../context/DataContext';
import { useToast } from '../context/ToastContext';
import { formatNumber, formatINR, formatDate, cn } from '../lib/utils';

export default function ProductDetailPage() {
  const { productId } = useParams();
  const { user } = useAuth();
  const { refresh } = useData();
  const toast = useToast();
  const navigate = useNavigate();

  const [product, setProduct] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ordering, setOrdering] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    if (!user || !productId) return;
    setLoading(true);
    try {
      const [p, t, f] = await Promise.all([
        getProduct(user, productId),
        getInventoryTimeline(user, productId, { days: 45 }),
        getProductForecast(user, productId, 30).catch(() => null),
      ]);
      setProduct(p);
      setTimeline(t);
      setForecast(f);
      setError('');
    } catch (e) {
      setError(e.message || 'Unable to load product details. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, productId, refreshKey]);

  useEffect(() => {
    load();
  }, [load]);

  const handleOrder = async () => {
    if (!product?.recommendedOrderQty) return;
    setOrdering(true);
    try {
      await placeSimulatedOrder(user, product.id, product.recommendedOrderQty);
      refresh();
      setRefreshKey((k) => k + 1);
      toast.success(`Purchase order for ${product.recommendedOrderQty} units placed.`);
    } catch {
      toast.error('Unable to place the order. Please try again.');
    } finally {
      setOrdering(false);
    }
  };

  const handleRestock = async (qty) => {
    setOrdering(true);
    try {
      await placeSimulatedOrder(user, product.id, qty);
      refresh();
      setRefreshKey((k) => k + 1);
      toast.success(`Purchase order for ${qty} units placed.`);
    } catch {
      toast.error('Unable to place the order. Please try again.');
    } finally {
      setOrdering(false);
    }
  };

  if (loading && !product) {
    return (
      <div className="space-y-5">
        <LoadingSkeleton rows={2} />
        <SkeletonChart />
      </div>
    );
  }

  if (error && !product) {
    return (
      <Card className="py-16">
        <EmptyState
          icon={AlertTriangle}
          title="Product not found"
          description={error}
          actionLabel="Back to products"
          onAction={() => navigate('/app/products')}
        />
      </Card>
    );
  }

  const p = product;
  const decision =
    p.status === 'critical' || p.status === 'low'
      ? {
          ok: false,
          title: p.status === 'critical' ? 'Reorder immediately' : 'Reorder recommended',
          action: `Reorder ${p.recommendedOrderQty || 20} units`,
          reason:
            p.status === 'critical'
              ? `Projected demand during supplier lead time (${p.projectedDemandDuringLeadTime} units) is higher than the current inventory position (${p.inventoryPosition} units).`
              : `Current stock (${p.currentStock}) is below the reorder point (${p.reorderPoint}). Demand during lead time is projected at ${p.projectedDemandDuringLeadTime} units.`,
        }
      : {
          ok: true,
          title: 'No immediate reorder',
          action: 'No action',
          reason: `Current inventory (${p.currentStock} units) is above the calculated reorder point (${p.reorderPoint}), and projected demand during lead time (${p.projectedDemandDuringLeadTime} units) is covered.`,
        };

  const summaryStats = [
    { label: 'Current Stock', value: formatNumber(p.currentStock), icon: Package, tone: 'bg-brand-50 text-brand-600' },
    { label: '30-Day Forecast', value: p.forecast30 != null ? formatNumber(p.forecast30) : '—', icon: TrendingUp, tone: 'bg-violet-50 text-violet-600' },
    { label: 'Reorder Point', value: formatNumber(p.reorderPoint), icon: ShieldAlert, tone: 'bg-amber-50 text-amber-600' },
    { label: 'Safety Stock', value: formatNumber(p.safetyStock), icon: ShieldCheck, tone: 'bg-emerald-50 text-emerald-600' },
    { label: 'Lead Time', value: `${p.leadTimeDays} days`, icon: Timer, tone: 'bg-sky-50 text-sky-600' },
  ];

  return (
    <div className="space-y-5">
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back
      </button>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {p.name}
            <span className="rounded-lg bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-500">{p.id}</span>
            <span className="rounded-lg bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">{p.category}</span>
          </span>
        }
        subtitle="Product-level inventory intelligence and demand outlook."
        actions={
          <Button variant="secondary" icon={Pencil} onClick={() => navigate('/app/products')}>
            Edit Product
          </Button>
        }
      />

      {/* Summary */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        {summaryStats.map((s) => (
          <div key={s.label} className="card p-4">
            <div className="flex items-center gap-2.5">
              <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', s.tone)}>
                <s.icon className="h-4 w-4" />
              </span>
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{s.label}</span>
            </div>
            <p className="tnum mt-3 text-2xl font-extrabold text-slate-900">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Demand chart */}
        <Card
          title="Demand — Historical vs Forecast"
          subtitle="Last 60 days actuals and AI forecast with confidence range"
          className="lg:col-span-2"
        >
          {forecast ? (
            <DemandChart
              actuals={forecast.actuals.slice(-60)}
              forecast={forecast.points}
              height={290}
              formatter={(v) => formatNumber(v) + ' units'}
              footer={
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                  <TrendIndicator trend={forecast.trend} />
                  <span>
                    Forecast total (30 days):{' '}
                    <span className="tnum font-bold text-slate-800">{formatNumber(forecast.total)} units</span>
                  </span>
                  <span>
                    Peak: <span className="font-semibold">{formatDate(forecast.peakDate)}</span> (
                    <span className="tnum">{formatNumber(forecast.peakUnits)}</span>)
                  </span>
                </div>
              }
            />
          ) : (
            <p className="py-12 text-center text-sm text-slate-400">
              Not enough sales history to generate a forecast for this product.
            </p>
          )}
        </Card>

        {/* Inventory decision */}
        <Card title="Inventory Decision" subtitle="Plain-language recommendation">
          <div
            className={cn(
              'rounded-2xl border p-5',
              decision.ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-rose-200 bg-rose-50/60',
            )}
          >
            <div className="flex items-center justify-between">
              <StatusBadge status={p.status} />
              <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl', decision.ok ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600')}>
                {decision.ok ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
              </span>
            </div>
            <p className="mt-3 text-lg font-extrabold text-slate-900">
              Inventory Status: <span className={decision.ok ? 'text-emerald-700' : 'text-rose-700'}>{p.status === 'low' ? 'Low Stock' : p.status === 'critical' ? 'Critical' : 'Healthy'}</span>
            </p>
            <p className="mt-1 text-sm font-bold text-slate-800">Recommended Action: {decision.title}</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">{decision.reason}</p>
          </div>

          <div className="mt-4 space-y-2.5 rounded-xl border border-slate-100 p-4 text-sm">
            <Row label="Unit cost" value={formatINR(p.unitCost)} />
            <Row label="Selling price" value={formatINR(p.sellingPrice)} />
            <Row label="Open orders" value={formatNumber(p.openOrderQty)} />
            <Row label="Inventory position" value={formatNumber(p.inventoryPosition)} />
            <Row label="Supplier" value={p.supplier} />
            <Row label="Daily demand" value={`${formatNumber(p.dailyAvg)} units`} />
          </div>

          {!decision.ok && (
            <Button className="mt-4 w-full" icon={ShoppingCart} loading={ordering} onClick={handleOrder}>
              {p.recommendedOrderQty
                ? `Place Order — ${p.recommendedOrderQty} units`
                : 'Place Order'}
            </Button>
          )}
          {!decision.ok && p.recommendedOrderQty === 0 && (
            <Button className="mt-2 w-full" variant="secondary" icon={Truck} loading={ordering} onClick={() => handleRestock(20)}>
              Order 20 units
            </Button>
          )}
        </Card>
      </div>

      {/* Inventory timeline */}
      <Card
        title="Inventory Timeline"
        subtitle="Projected stock movement against reorder point (green = safe heading)"
        actions={
          <button
            onClick={() => {
              setRefreshKey((k) => k + 1);
              toast.info('Refreshing stock projection…');
            }}
            className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        }
      >
        {timeline ? (
          <StockLineChart
            points={timeline.points}
            height={280}
            reference={timeline.reorderPoint}
            formatter={(v) => formatNumber(v) + ' units'}
          />
        ) : (
          <SkeletonChart height={280} />
        )}
        {timeline?.expectedDepletion && (
          <p className="mt-3 flex items-center gap-2 text-xs font-semibold text-amber-600">
            <AlertTriangle className="h-4 w-4" />
            At current pace, stock is expected to deplete by {formatDate(timeline.expectedDepletion)} if not replenished.
          </p>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="tnum text-sm font-semibold text-slate-700">{value}</span>
    </div>
  );
}