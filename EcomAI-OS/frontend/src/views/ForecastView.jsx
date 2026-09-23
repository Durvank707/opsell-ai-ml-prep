import React, { useState, useEffect } from 'react';
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
  ShoppingBag,
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { generateForecast } from '../api/client';

export default function ForecastView({
  products = [],
  selectedProductId,
  onSelectProduct,
}) {
  const [selectedSku, setSelectedSku] = useState(selectedProductId || 'P001');
  const [horizon, setHorizon] = useState(30);
  const [loading, setLoading] = useState(false);
  const [forecastData, setForecastData] = useState(null);

  // Scenario
  const [scenarioActive, setScenarioActive] = useState(false);
  const [discount, setDiscount] = useState(10);
  const [promotion, setPromotion] = useState(1);
  const [priceOverride, setPriceOverride] = useState('');

  const currentProduct = products.find((p) => p.product_id === selectedSku);

  const fetchDemand = async (applyScenario = false) => {
    if (!selectedSku) return;
    setLoading(true);
    try {
      const payload = applyScenario
        ? {
            discount: Number(discount),
            promotion: Number(promotion),
            price: priceOverride ? Number(priceOverride) : undefined,
          }
        : null;

      const data = await generateForecast(selectedSku, horizon, payload);
      setForecastData(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedSku(selectedProductId);
    fetchDemand(false);
  }, [selectedProductId, horizon]);

  const handleApplyScenario = () => {
    setScenarioActive(true);
    fetchDemand(true);
  };

  const handleReset = () => {
    setScenarioActive(false);
    setDiscount(10);
    setPromotion(1);
    setPriceOverride('');
    fetchDemand(false);
  };

  // Recharts payload
  const chartData = [];
  if (forecastData) {
    forecastData.recent_actuals?.slice(-14).forEach((pt) => {
      chartData.push({
        date: pt.date,
        Actual: pt.units_sold,
      });
    });
    forecastData.forecast_points?.forEach((pt) => {
      chartData.push({
        date: pt.date,
        Forecast: pt.forecast_units,
        Scenario: pt.scenario_units,
      });
    });
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Demand Forecast</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            Predict customer demand and model promotional pricing scenarios before launching campaigns.
          </p>
        </div>

        {/* Product Picker */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 font-medium">SKU:</span>
          <select
            value={selectedSku}
            onChange={(e) => {
              setSelectedSku(e.target.value);
              onSelectProduct(e.target.value);
            }}
            className="bg-slate-900 border border-slate-700 text-xs font-semibold text-slate-100 rounded-xl px-3 py-2 focus:outline-none cursor-pointer"
          >
            {products.map((p) => (
              <option key={p.product_id} value={p.product_id}>
                {p.product_id} — {p.product_name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Plain English Insight Banner */}
      {forecastData && (
        <div className="p-4 rounded-xl bg-gradient-to-r from-emerald-950/40 via-slate-900 to-slate-900 border border-emerald-500/30">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
              Demand Insight
            </span>
          </div>
          <p className="text-sm font-semibold text-white mt-1">
            {forecastData.plain_english_summary}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {currentProduct?.plain_english_insight}
          </p>
        </div>
      )}

      {/* What-If Promotional Simulator */}
      <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-bold text-white">Promotional What-If Simulator</h2>
          </div>
          {scenarioActive && (
            <span className="text-xs font-bold text-amber-400 font-mono">
              Scenario Active ({forecastData?.scenario_lift_percent ? `+${forecastData.scenario_lift_percent}% Lift` : ''})
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">
          <div>
            <div className="flex justify-between text-xs text-slate-400 mb-1">
              <span>Discount Rate:</span>
              <span className="font-mono text-amber-400 font-bold">{discount}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="50"
              step="5"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              className="w-full accent-amber-400 h-1.5 bg-slate-950 rounded-lg cursor-pointer"
            />
          </div>

          <div>
            <span className="text-xs text-slate-400 block mb-1">Marketing Promo:</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPromotion(1)}
                className={`flex-1 py-1.5 text-xs font-bold rounded-lg border transition-colors ${
                  promotion === 1
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-slate-950 text-slate-400 border-slate-800'
                }`}
              >
                Active
              </button>
              <button
                onClick={() => setPromotion(0)}
                className={`flex-1 py-1.5 text-xs font-bold rounded-lg border transition-colors ${
                  promotion === 0
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-slate-950 text-slate-400 border-slate-800'
                }`}
              >
                None
              </button>
            </div>
          </div>

          <div>
            <span className="text-xs text-slate-400 block mb-1">Override Price (₹):</span>
            <input
              type="number"
              placeholder={`Base: ₹${currentProduct?.unit_price || 1999}`}
              value={priceOverride}
              onChange={(e) => setPriceOverride(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-amber-400"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleApplyScenario}
              disabled={loading}
              className="flex-1 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors shadow-sm"
            >
              <Zap className="w-3.5 h-3.5 fill-current" />
              <span>Simulate Lift</span>
            </button>
            {scenarioActive && (
              <button
                onClick={handleReset}
                className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-colors"
                title="Reset"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Demand Curve Chart */}
      <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-bold text-white">
              {currentProduct?.product_name || selectedSku} — Demand Trajectory
            </h2>
            <p className="text-xs text-slate-400">
              14 days of actual history and projected next 30 days.
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs font-semibold">
            <span className="text-slate-400 flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-slate-400"></span>
              Historical Actuals
            </span>
            <span className="text-emerald-400 flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-emerald-400"></span>
              Projected Demand
            </span>
            {scenarioActive && (
              <span className="text-amber-400 flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-amber-400"></span>
                Promotional Lift
              </span>
            )}
          </div>
        </div>

        {loading ? (
          <div className="h-64 flex items-center justify-center text-slate-400 text-xs">
            Calculating demand forecast...
          </div>
        ) : (
          <div className="h-64 w-full">
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
                    fontSize: '12px',
                  }}
                />
                <Line type="monotone" dataKey="Actual" stroke="#94a3b8" strokeWidth={2} dot={{ r: 2 }} />
                <Line type="monotone" dataKey="Forecast" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} />
                {scenarioActive && (
                  <Line type="monotone" dataKey="Scenario" stroke="#f59e0b" strokeWidth={2.5} strokeDasharray="3 3" dot={{ r: 2 }} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
