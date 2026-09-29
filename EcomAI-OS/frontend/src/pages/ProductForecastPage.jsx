import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Info,
  LineChart,
  Package,
  TrendingUp,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { ForecastStatusBadge, TrendIndicator } from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { LoadingSkeleton, SkeletonChart } from '../components/ui/Skeleton';
import { DemandChart } from '../components/charts';
import { getProductForecast } from '../services/forecastService';
import {
  forecastExplanation,
  forecastModelLabel,
  forecastStatus,
  forecastWarning,
  historyLabel,
} from '../services/forecastStatus';
import { useAuth } from '../context/AuthContext';
import { formatDate, formatNumber, cn } from '../lib/utils';

/**
 * One product's demand forecast, on its own page.
 *
 * The numbers come from the existing product forecast endpoint
 * (GET /api/v2/forecast/{product_id}) through the same service every other
 * page uses — this page adds no forecasting of its own, and it makes exactly
 * one request: the response already carries the product's name, category,
 * history, model and trend, so loading the product separately would only
 * duplicate the round trip.
 *
 * Everything above the chart is read from the eligibility decision the endpoint
 * already returns, so a product with no sales history says so instead of
 * showing a "Stable" trend that was never calculated from demand.
 */
export default function ProductForecastPage() {
  const { productId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!user || !productId) return;
    setLoading(true);
    try {
      setForecast(await getProductForecast(user, productId, 30));
      setError('');
    } catch (e) {
      setForecast(null);
      setError(
        e?.message || 'The forecast for this product could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, [user, productId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !forecast) {
    return (
      <div className="space-y-5">
        <LoadingSkeleton rows={2} />
        <SkeletonChart />
      </div>
    );
  }

  if (error || !forecast) {
    return (
      <Card className="py-16">
        <EmptyState
          icon={AlertTriangle}
          title="Product forecast unavailable"
          description={
            error ||
            'The forecast for this product could not be loaded. Please try again.'
          }
          actionLabel="Back to products"
          actionIcon={ArrowLeft}
          onAction={() => navigate('/app/products')}
        />
      </Card>
    );
  }

  const status = forecastStatus(forecast);
  const model = forecastModelLabel(forecast);
  const explanation = forecastExplanation(forecast);
  const warning = forecastWarning(forecast);
  const hasPoints = forecast.points.length > 0;
  const name = forecast.productName || productId;

  return (
    <div className="space-y-5">
      <button
        onClick={() => navigate(`/app/products/${productId}`)}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to {name}
      </button>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {name}
            <span className="rounded-lg bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-500">
              {forecast.productId || productId}
            </span>
            {forecast.category && (
              <span className="rounded-lg bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">
                {forecast.category}
              </span>
            )}
          </span>
        }
        subtitle="This product's own demand forecast, with the confidence behind it."
        actions={
          <>
            <Button
              variant="secondary"
              icon={Package}
              onClick={() => navigate(`/app/products/${productId}`)}
            >
              Product Details
            </Button>
            <Button
              variant="secondary"
              icon={LineChart}
              onClick={() => navigate('/app/forecast')}
            >
              Portfolio Forecast
            </Button>
          </>
        }
      />

      {/* What this forecast is based on */}
      <Card
        title="Forecast status"
        subtitle="Where these numbers come from, and how much weight they carry"
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Fact label="Forecast status" className="items-start">
            <ForecastStatusBadge status={status} />
          </Fact>
          <Fact label="Forecast model" value={model || 'Not labelled'} />
          <Fact label="History available" value={historyLabel(forecast)} />
          <Fact label="Trend">
            {status.trendMeaningful ? (
              <TrendIndicator trend={forecast.trend} />
            ) : (
              <span className="text-sm text-slate-400">
                No trend — there is no demand history to compare
              </span>
            )}
          </Fact>
        </div>

        {explanation && (
          <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 text-sm leading-relaxed text-amber-900">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{explanation}</span>
          </p>
        )}
        {warning && (
          <p className="mt-2.5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 text-sm leading-relaxed text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{warning}</span>
          </p>
        )}
      </Card>

      {/* The forecast itself */}
      <Card
        title={`${forecast.horizon || 30}-day demand forecast`}
        subtitle="Actual sales against the forecast and its confidence range"
      >
        {hasPoints ? (
          <>
            <DemandChart
              actuals={forecast.actuals}
              forecast={forecast.points}
              height={290}
              formatter={(v) => `${formatNumber(v)} units`}
              footer={
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500">
                  <span>
                    Total demand:{' '}
                    <span className="tnum font-bold text-slate-800">
                      {formatNumber(forecast.total)} units
                    </span>
                  </span>
                  <span>
                    Average per day:{' '}
                    <span className="tnum font-bold text-slate-800">
                      {formatNumber(forecast.avgDaily)} units
                    </span>
                  </span>
                  {forecast.peakDate && (
                    <span>
                      Busiest day:{' '}
                      <span className="font-semibold text-slate-700">
                        {formatDate(forecast.peakDate)}
                      </span>{' '}
                      (<span className="tnum">{formatNumber(forecast.peakUnits)}</span> units)
                    </span>
                  )}
                </div>
              }
            />
          </>
        ) : (
          <EmptyState
            compact
            icon={TrendingUp}
            title="No demand forecast to show"
            description="No forecast could be produced for this product from the sales data available so far. The reason is stated above."
          />
        )}
      </Card>

      {hasPoints && (
        <Card
          title="Forecast day by day"
          subtitle={`Each day's expected units, with the range the model considers likely`}
          pad={false}
        >
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white text-[11px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th scope="col" className="px-5 py-2.5 text-left font-bold">
                    Day
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-left font-bold">
                    Date
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-right font-bold">
                    Forecast
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-right font-bold">
                    Likely range
                  </th>
                </tr>
              </thead>
              <tbody>
                {forecast.points.map((point, index) => (
                  <tr key={point.date || index} className="border-t border-slate-100">
                    <td className="px-5 py-2.5 text-slate-500">
                      Day {index + 1}
                    </td>
                    <td className="px-5 py-2.5 font-medium text-slate-700">
                      {formatDate(point.date)}
                    </td>
                    <td className="tnum px-5 py-2.5 text-right font-bold text-slate-900">
                      {formatNumber(point.forecast)}
                    </td>
                    <td className="tnum px-5 py-2.5 text-right text-slate-500">
                      {formatNumber(point.lower)} – {formatNumber(point.upper)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/** One labelled fact in the status grid. */
function Fact({ label, value, children, className }) {
  return (
    <div className={cn('rounded-xl border border-slate-100 p-4', className)}>
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <div className="mt-2 text-sm font-semibold text-slate-800">{value}</div>
      {children}
    </div>
  );
}
