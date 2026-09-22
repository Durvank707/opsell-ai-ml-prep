import React, { useState, useEffect } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';
import {
  TrendingUp,
  Sliders,
  Sparkles,
  RotateCcw,
  Zap,
  Calendar,
  Layers,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { generateForecast } from '../api/client';

export default function ForecastingView({
  products,
  selectedProductId,
  onSelectProduct,
}) {
  const [horizon, setHorizon] = useState(30);
  const [loading, setLoading] = useState(false);
  const [forecastData, setForecastData] = useState(null);
  const [error, setError] = useState(null);

  // What-If Scenario Controls
  const [scenarioEnabled, setScenarioEnabled] = useState(false);
  const [scenarioDiscount, setScenarioDiscount] = useState(10);
  const [scenarioPromotion, setScenarioPromotion] = useState(1);
  const [scenarioPrice, setScenarioPrice] = useState('');

  const currentProduct = products.find((p) => p.product_id === selectedProductId);

  const loadForecast = async (useScenario = false) => {
    if (!selectedProductId) return;
    setLoading(true);
    setError(null);
    try {
      const scenarioPayload = useScenario
        ? {
            discount: Number(scenarioDiscount),
            promotion: Number(scenarioPromotion),
            price: scenarioPrice ? Number(scenarioPrice) : undefined,
          }
        : null;

      const data = await generateForecast(selectedProductId, horizon, scenarioPayload);
      setForecastData(data);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Failed to generate demand forecast');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedProductId) {
      setScenarioEnabled(false);
      loadForecast(false);
    }
  }, [selectedProductId, horizon]);

  const handleApplyScenario = () => {
    setScenarioEnabled(true);
    loadForecast(true);
  };

  const handleResetScenario = () => {
    setScenarioEnabled(false);
    setScenarioDiscount(10);
    setScenarioPromotion(1);
    setScenarioPrice('');
    loadForecast(false);
  };

  // Prepare combined timeline for Recharts:
  // Last 14 days of actual historical demand + future forecasted points
  const chartData = [];

  if (forecastData) {
    if (forecastData.recent_actuals) {
      const recent = forecastData.recent_actuals.slice(-14);
      recent.forEach((pt) => {
        chartData.push({
          date: pt.date,
          actual: pt.units_sold,
          type: 'Actual',
        });
      });
    }

    forecastData.forecast_points.forEach((pt) => {
      chartData.push({
        date: pt.date,
        forecast: pt.forecast_units,
        lowerBound: pt.lower_bound,
        upperBound: pt.upper_bound,
        baseline: pt.baseline_units,
        scenario: pt.scenario_units,
        type: 'Forecast',
      });
    });
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Header & Controls bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-extrabold text-white tracking-tight">
              AI Demand Forecasting & Scenario Lab
            </h1>
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              Recursive XGBoost
            </span>
          </div>
          <p className="text-slate-400 text-sm mt-1">
            Simulate future demand curves and run What-If promotional campaigns to evaluate sales lift.
          </p>
        </div>

        {/* Horizon selector */}
        <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 p-1.5 rounded-xl">
          <Calendar className="w-4 h-4 text-slate-400 ml-2" />
          <span className="text-xs text-slate-400 font-medium">Forecast Horizon:</span>
          {[7, 14, 30, 60].map((h) => (
            <button
              key={h}
              onClick={() => setHorizon(h)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                horizon === h
                  ? 'bg-emerald-500 text-slate-950 shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              {h} Days
            </button>
          ))}
        </div>
      </div>

      {/* What-If Scenario Builder Box */}
      <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900/90 via-slate-900/70 to-slate-950 border border-slate-800 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">What-If Promotional Scenario Lab</h2>
              <p className="text-xs text-slate-400">
                Adjust pricing & promotional triggers to simulate demand lift before executing marketing campaigns.
              </p>
            </div>
          </div>
          {scenarioEnabled && (
            <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              Scenario Active
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          {/* Discount Slider */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Promotional Discount:</span>
              <span className="font-bold text-amber-400 font-mono">{scenarioDiscount}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="50"
              step="5"
              value={scenarioDiscount}
              onChange={(e) => setScenarioDiscount(e.target.value)}
              className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-400"
            />
          </div>

          {/* Promotion Campaign Flag */}
          <div className="space-y-1.5">
            <span className="text-xs text-slate-400 block">Marketing Campaign:</span>
            <div className="flex gap-2">
              <button
                onClick={() => setScenarioPromotion(1)}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                  scenarioPromotion === 1
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-slate-800/60 text-slate-400 border-slate-700 hover:text-slate-200'
                }`}
              >
                Campaign On
              </button>
              <button
                onClick={() => setScenarioPromotion(0)}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                  scenarioPromotion === 0
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-slate-800/60 text-slate-400 border-slate-700 hover:text-slate-200'
                }`}
              >
                Campaign Off
              </button>
            </div>
          </div>

          {/* Override Price */}
          <div className="space-y-1.5">
            <span className="text-xs text-slate-400 block">Override Price (₹):</span>
            <input
              type="number"
              placeholder={`Base: ₹${currentProduct?.unit_price || 1999}`}
              value={scenarioPrice}
              onChange={(e) => setScenarioPrice(e.target.value)}
              className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
            />
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleApplyScenario}
              disabled={loading}
              className="flex-1 py-2 px-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-amber-500/10 transition-colors"
            >
              <Zap className="w-3.5 h-3.5 fill-current" />
              <span>Simulate Lift</span>
            </button>
            {scenarioEnabled && (
              <button
                onClick={handleResetScenario}
                disabled={loading}
                className="py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs flex items-center justify-center transition-colors"
                title="Reset to Baseline ML"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Summary Stat Cards */}
      {forecastData && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Total Forecast Demand
            </span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-extrabold text-white">
                {forecastData.total_forecast_units.toLocaleString()}
              </span>
              <span className="text-xs text-slate-400">units</span>
            </div>
            {forecastData.scenario_applied && forecastData.scenario_lift_percent !== null && (
              <div className="mt-1 flex items-center gap-1 text-xs font-bold text-amber-400">
                <ArrowUp className="w-3.5 h-3.5" />
                <span>+{forecastData.scenario_lift_percent}% Lift vs Base</span>
              </div>
            )}
          </div>

          <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Avg Daily Run Rate
            </span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-extrabold text-emerald-400">
                {forecastData.avg_daily_demand}
              </span>
              <span className="text-xs text-slate-400">units / day</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">Smoothed velocity</p>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Peak Day Projected
            </span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-extrabold text-white">
                {forecastData.peak_units}
              </span>
              <span className="text-xs text-slate-400">units</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">Expected on {forecastData.peak_date}</p>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Baseline (Moving Avg)
            </span>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-extrabold text-purple-400">
                {forecastData.baseline_total_units.toLocaleString()}
              </span>
              <span className="text-xs text-slate-400">units</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">Simple 7-day trailing</p>
          </div>
        </div>
      )}

      {/* Interactive Forecast Chart */}
      <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <div>
            <h2 className="text-base font-bold text-white">
              Demand Trajectory ({currentProduct?.product_name || selectedProductId})
            </h2>
            <p className="text-xs text-slate-400">
              Comparing 14-day history, recursive XGBoost ML forecast, and What-If scenario curves.
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5 text-slate-400">
              <span className="w-3 h-0.5 bg-slate-400 inline-block"></span>
              <span>Actuals</span>
            </div>
            <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
              <span className="w-3 h-0.5 bg-emerald-400 inline-block"></span>
              <span>XGBoost ML</span>
            </div>
            {scenarioEnabled && (
              <div className="flex items-center gap-1.5 text-amber-400 font-semibold">
                <span className="w-3 h-0.5 bg-amber-400 inline-block"></span>
                <span>Scenario Lift</span>
              </div>
            )}
            <div className="flex items-center gap-1.5 text-purple-400">
              <span className="w-3 h-0.5 bg-purple-400 inline-block"></span>
              <span>Moving Avg</span>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="h-80 flex items-center justify-center text-slate-400 text-sm">
            Recalculating recursive demand forecasts...
          </div>
        ) : (
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 11 }} />
                <YAxis stroke="#64748b" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0f172a',
                    borderColor: '#334155',
                    borderRadius: '0.75rem',
                    color: '#f8fafc',
                    fontSize: '12px',
                  }}
                />
                {/* Confidence Interval band */}
                <Area
                  type="monotone"
                  dataKey="upperBound"
                  stroke="none"
                  fill="#10b981"
                  fillOpacity={0.12}
                  name="Confidence Range"
                />
                {/* Historical Actuals */}
                <Line
                  type="monotone"
                  dataKey="actual"
                  stroke="#94a3b8"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  name="Historical Demand"
                />
                {/* Base XGBoost Forecast */}
                <Line
                  type="monotone"
                  dataKey="forecast"
                  stroke="#10b981"
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                  name="XGBoost Forecast"
                />
                {/* What-If Scenario Line */}
                {scenarioEnabled && (
                  <Line
                    type="monotone"
                    dataKey="scenario"
                    stroke="#f59e0b"
                    strokeWidth={2.5}
                    strokeDasharray="4 4"
                    dot={{ r: 3 }}
                    name="Scenario Demand"
                  />
                )}
                {/* Moving Average Baseline */}
                <Line
                  type="monotone"
                  dataKey="baseline"
                  stroke="#c084fc"
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  dot={false}
                  name="Baseline (MA-7)"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Forecast Data Table */}
      {forecastData && (
        <div className="rounded-2xl bg-slate-900/70 border border-slate-800 overflow-hidden">
          <div className="p-4 border-b border-slate-800 flex justify-between items-center">
            <h3 className="text-sm font-bold text-white">Daily Forecast Schedule</h3>
            <span className="text-xs text-slate-400 font-mono">
              Horizon: {horizon} days ({forecastData.forecast_points[0]?.date} to{' '}
              {forecastData.forecast_points.slice(-1)[0]?.date})
            </span>
          </div>
          <div className="max-h-60 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-400 sticky top-0 border-b border-slate-800">
                <tr>
                  <th className="py-2.5 px-4">Forecast Date</th>
                  <th className="py-2.5 px-4 text-right">XGBoost Forecast</th>
                  {scenarioEnabled && (
                    <th className="py-2.5 px-4 text-right text-amber-400">Scenario Forecast</th>
                  )}
                  <th className="py-2.5 px-4 text-right text-purple-400">Baseline (MA-7)</th>
                  <th className="py-2.5 px-4 text-right">Error Range (±1.65σ)</th>
                  <th className="py-2.5 px-4 text-right">Discount</th>
                  <th className="py-2.5 px-4 text-center">Promo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {forecastData.forecast_points.map((pt) => (
                  <tr key={pt.date} className="hover:bg-slate-800/40">
                    <td className="py-2 px-4 text-slate-300">{pt.date}</td>
                    <td className="py-2 px-4 text-right font-bold text-emerald-400">
                      {pt.forecast_units} u
                    </td>
                    {scenarioEnabled && (
                      <td className="py-2 px-4 text-right font-bold text-amber-400">
                        {pt.scenario_units} u
                      </td>
                    )}
                    <td className="py-2 px-4 text-right text-purple-300">{pt.baseline_units} u</td>
                    <td className="py-2 px-4 text-right text-slate-400">
                      [{pt.lower_bound} - {pt.upper_bound}]
                    </td>
                    <td className="py-2 px-4 text-right text-slate-300">{pt.discount}%</td>
                    <td className="py-2 px-4 text-center">
                      {pt.promotion ? (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-sans">
                          Active
                        </span>
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
