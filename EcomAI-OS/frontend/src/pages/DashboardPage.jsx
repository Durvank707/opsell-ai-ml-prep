import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  PackagePlus,
  UploadCloud,
  TrendingUp,
  Package,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Calendar,
  Check,
  ShoppingCart,
  FlaskConical,
} from 'lucide-react';
import KPICard from '../components/KPICard';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import { StatusBadge } from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { LoadingSkeleton, SkeletonChart } from '../components/ui/Skeleton';
import { getDashboard } from '../services/dashboardService';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { DemandChart, HealthDonut } from '../components/charts';
import { formatNumber, formatINR, timeAgo, cn } from '../lib/utils';

const PERIODS = [
  { key: 'today', label: 'Today', days: 7 },
  { key: '7d', label: 'Last 7 Days', days: 7 },
  { key: '30d', label: 'Last 30 Days', days: 30 },
  { key: 'custom', label: 'Custom Range', days: 30 },
];

const ACTIVITY_ICONS = {
  product_added: { icon: PackagePlus, cls: 'bg-brand-50 text-brand-600' },
  sales_uploaded: { icon: UploadCloud, cls: 'bg-emerald-50 text-emerald-600' },
  forecast_generated: { icon: TrendingUp, cls: 'bg-violet-50 text-violet-600' },
  inventory_updated: { icon: Package, cls: 'bg-amber-50 text-amber-600' },
  simulation_completed: { icon: FlaskConical, cls: 'bg-sky-50 text-sky-600' },
  product_deleted: { icon: Package, cls: 'bg-rose-50 text-rose-600' },
};

export default function DashboardPage() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [dash, setDash] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState('30d');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getDashboard(user, { period: PERIODS.find((p) => p.key === period).days });
      setDash(data);
      setError('');
    } catch {
      setError('Unable to load dashboard. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, period]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (user?.name || 'there').split(' ')[0];

  const setup = dash?.setup;

  useEffect(() => {
    if (error) toast.error(error);
  }, [error, toast]);

  if (loading && !dash) {
    return (
      <div className="space-y-6">
        <LoadingSkeleton rows={2} />
        <SkeletonChart />
      </div>
    );
  }

  if (error && !dash) {
    return (
      <Card className="py-16">
        <EmptyState
          icon={AlertTriangle}
          title="Unable to load inventory"
          description={error}
          actionLabel="Try again"
          onAction={load}
        />
      </Card>
    );
  }

  const { kpis, health, chart, alerts, activity } = dash;

  // ---- Onboarding empty-state ----
  if (setup && !setup.complete) {
    return <OnboardingView setup={setup} firstName={firstName} greeting={greeting} />;
  }

  return (
    <div className="space-y-6">
      {/* Heading + period selector */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
            {greeting}, {firstName}
          </h1>
          <p className="mt-1 text-sm text-slate-500">Here’s what’s happening with your inventory.</p>
        </div>
        <div ref={menuRef} className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            <Calendar className="h-4 w-4 text-slate-400" />
            {PERIODS.find((p) => p.key === period)?.label}
            <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', menuOpen && 'rotate-180')} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-30 mt-1.5 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-pop animate-slide-up">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => {
                    setPeriod(p.key);
                    setMenuOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between px-3.5 py-2 text-sm hover:bg-slate-50',
                    period === p.key ? 'font-semibold text-brand-700' : 'text-slate-600',
                  )}
                >
                  {p.label}
                  {period === p.key && <Check className="h-4 w-4" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KPICard icon={Package} label="Total Products" value={formatNumber(kpis.totalProducts)} tone="indigo" sub="Active SKUs in catalog" />
        <KPICard
          icon={ShoppingCart}
          label="Products to Reorder"
          value={formatNumber(kpis.productsToReorder)}
          tone="amber"
          status={kpis.productsToReorder > 0 ? 'warn' : 'good'}
          sub="Below reorder point"
        />
        <KPICard
          icon={AlertTriangle}
          label="Stockout Risk"
          value={formatNumber(kpis.stockoutRisk)}
          tone="red"
          status={kpis.stockoutRisk > 0 ? 'critical' : 'good'}
          sub="Imminent stockout"
        />
        <KPICard
          icon={PackagePlus}
          label="Excess Inventory"
          value={formatNumber(kpis.excessInventory)}
          tone="blue"
          sub="Well above target"
        />
        <KPICard icon={CheckCircle2} label="Inventory Value" value={dash.valueLabel} tone="green" sub="At unit cost" prefix="₹" />
      </div>

      {/* Health + demand chart */}
      <div className="grid gap-5 lg:grid-cols-5">
        <Card title="Inventory Health" subtitle="Distribution across all SKUs" className="lg:col-span-2">
          <div className="py-2">
            <HealthDonut healthy={health.healthy} atRisk={health.atRisk} critical={health.critical} />
          </div>
          <div className="mt-4">
            <Link to="/app/inventory?status=critical" className="flex items-center justify-between rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100">
              <span>Review critical stock</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </Card>

        <Card
          title="Actual Demand vs Forecast Demand"
          subtitle={`Portfolio-wide over the last ${PERIODS.find((p) => p.key === period).days} days`}
          className="lg:col-span-3"
        >
          {chart?.actual?.length ? (
            <DemandChart
              actuals={chart.actual}
              forecast={chart.forecast}
              height={300}
              formatter={(v) => formatNumber(v) + ' units'}
            />
          ) : (
            <p className="py-16 text-center text-sm text-slate-400">Not enough demand data to display.</p>
          )}
        </Card>
      </div>

      {/* Alerts + activity */}
      <div className="grid gap-5 lg:grid-cols-5">
        <Card
          title="Inventory Alerts"
          subtitle={
            dash.totalAlertProductCount > 0
              ? `${dash.totalAlertProductCount} products need attention`
              : 'All products are within healthy ranges'
          }
          className="lg:col-span-3"
          bodyClassName="p-0"
          pad={false}
        >
          {alerts.length === 0 ? (
            <div className="p-8">
              <EmptyState
                compact
                icon={CheckCircle2}
                title="No inventory alerts"
                description="All products are above their reorder points."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/60">
                    <th className="table-th">Product</th>
                    <th className="table-th">Status</th>
                    <th className="table-th text-right">Current Stock</th>
                    <th className="table-th text-right">Reorder Point</th>
                    <th className="table-th">Recommended Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {alerts.map((a) => (
                    <tr
                      key={a.id}
                      onClick={() => navigate(`/app/products/${a.id}`)}
                      className="cursor-pointer transition-colors hover:bg-slate-50"
                    >
                      <td className="table-td font-semibold text-slate-800">{a.name}</td>
                      <td className="table-td">
                        <StatusBadge status={a.status} />
                      </td>
                      <td className="table-td text-right tnum font-semibold">{a.currentStock}</td>
                      <td className="table-td text-right tnum text-slate-500">{a.reorderPoint}</td>
                      <td className="table-td">
                        <span className={cn('text-xs font-semibold', a.severity === 'critical' ? 'text-rose-600' : 'text-amber-600')}>
                          {a.recommendedAction}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {alerts.length > 0 && (
            <div className="border-t border-slate-100 px-5 py-3">
              <Link to="/app/inventory?status=critical" className="text-xs font-semibold text-brand-600 hover:text-brand-700">
                View All Inventory →
              </Link>
            </div>
          )}
        </Card>

        <Card title="Recent Activity" subtitle="Latest events in your workspace" className="lg:col-span-2" bodyClassName="p-0" pad={false}>
          {activity.length === 0 ? (
            <div className="p-8">
              <EmptyState compact icon={Package} title="No activity yet" description="Your recent actions will appear here." />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {activity.slice(0, 6).map((a) => {
                const cfg = ACTIVITY_ICONS[a.type] || ACTIVITY_ICONS.inventory_updated;
                return (
                  <li key={a.id} className="flex gap-3 px-5 py-3.5">
                    <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', cfg.cls)}>
                      <cfg.icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800">{a.title}</p>
                      {a.description && <p className="mt-0.5 truncate text-xs text-slate-500">{a.description}</p>}
                      <p className="mt-0.5 text-[10px] font-medium text-slate-400">{timeAgo(a.time)}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ onboarding

const SETUP_STEPS = [
  {
    key: 'products',
    title: 'Add Products',
    description: 'Add your products and inventory information.',
    icon: PackagePlus,
    url: '/app/products',
    action: 'Add products',
  },
  {
    key: 'sales',
    title: 'Import Sales Data',
    description: 'Upload historical sales data so EcomAI-OS can understand demand.',
    icon: UploadCloud,
    url: '/app/sales',
    action: 'Upload sales',
  },
  {
    key: 'forecast',
    title: 'Generate Forecast',
    description: 'Run your first demand forecast after enough sales history is available.',
    icon: TrendingUp,
    url: '/app/forecast',
    action: 'Generate forecast',
  },
];

function OnboardingView({ setup, firstName, greeting }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
          {greeting}, {firstName}
        </h1>
        <p className="mt-1 text-sm text-slate-500">Here’s what’s happening with your inventory.</p>
      </div>

      <Card className="overflow-hidden">
        <div className="relative bg-gradient-to-br from-brand-700 via-brand-600 to-indigo-600 p-8 text-white">
          <div className="relative z-10 max-w-xl">
            <h2 className="text-2xl font-extrabold">Welcome to EcomAI-OS</h2>
            <p className="mt-2 text-sm text-brand-100">Let’s set up your inventory intelligence workspace.</p>
          </div>
          <div className="pointer-events-none absolute right-0 top-0 h-full w-1/2 opacity-20">
            {/* decorative chart bars */}
            <div className="flex h-full items-end justify-end gap-2 p-8">
              {[40, 65, 50, 78, 60, 88, 72, 96].map((h, i) => (
                <div key={i} className="w-8 rounded-t-lg bg-white" style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
        </div>

        <div className="p-6 md:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">Setup Progress</h3>
              <p className="mt-0.5 text-sm text-slate-500">
                {setup.completed} / {setup.total} completed
              </p>
            </div>
            <div className="flex w-full max-w-xs items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-600 transition-all duration-500"
                  style={{ width: `${(setup.completed / setup.total) * 100}%` }}
                />
              </div>
              <span className="tnum text-xs font-bold text-slate-600">{Math.round((setup.completed / setup.total) * 100)}%</span>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {SETUP_STEPS.map((step, i) => {
              const isDone = setup.steps.find((s) => s.key === step.key)?.complete;
              return (
                <button
                  key={step.key}
                  onClick={() => navigate(step.url)}
                  className={cn(
                    'flex flex-col items-start rounded-2xl border p-5 text-left transition-all',
                    isDone
                      ? 'border-emerald-200 bg-emerald-50/50'
                      : 'border-slate-200 bg-white hover:border-brand-300 hover:shadow-card',
                  )}
                >
                  <div className="flex w-full items-center justify-between">
                    <span
                      className={cn(
                        'flex h-11 w-11 items-center justify-center rounded-xl',
                        isDone ? 'bg-emerald-100 text-emerald-600' : 'bg-brand-50 text-brand-600',
                      )}
                    >
                      {isDone ? <CheckCircle2 className="h-5 w-5" /> : <step.icon className="h-5 w-5" />}
                    </span>
                    <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Step {i + 1}</span>
                  </div>
                  <h4 className="mt-4 text-sm font-bold text-slate-900">{step.title}</h4>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">{step.description}</p>
                  {!isDone && (
                    <span className="mt-3 flex items-center gap-1 text-xs font-semibold text-brand-600">
                      {step.action} <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  )}
                  {isDone && <span className="mt-3 text-xs font-semibold text-emerald-600">Completed</span>}
                </button>
              );
            })}
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            <Button icon={PackagePlus} onClick={() => navigate('/app/products')}>
              Add First Product
            </Button>
            <Button variant="secondary" onClick={() => navigate('/app/sales')}>
              Upload Sales Data
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}