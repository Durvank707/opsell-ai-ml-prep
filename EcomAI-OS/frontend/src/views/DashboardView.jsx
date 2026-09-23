import React, { useState, useEffect } from 'react';
import {
  Boxes,
  RotateCcw,
  AlertTriangle,
  TrendingUp,
  IndianRupee,
  ArrowRight,
  ShieldAlert,
  ArrowUpRight,
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

export default function DashboardView({
  overviewData,
  onSelectProduct,
  onNavigateTab,
}) {
  const [selectedSku, setSelectedSku] = useState('P001');
  const [forecastData, setForecastData] = useState(null);
  const [loadingForecast, setLoadingForecast] = useState(false);

  useEffect(() => {
    if (selectedSku) {
      setLoadingForecast(true);
      generateForecast(selectedSku, 30)
        .then((data) => setForecastData(data))
        .catch(console.error)
        .finally(() => setLoadingForecast(false));
    }
  }, [selectedSku]);

  if (!overviewData) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400">
        Loading dashboard metrics...
      </div>
    );
  }

  const {
    total_products = 5,
    products_to_reorder = 2,
    stockout_risk_count = 2,
    excess_inventory_count = 1,
    total_inventory_value = 1462600,
    alerts = [],
    products = [],
  } = overviewData;

  // Prepare chart data combining 14-day history and 30-day forecast
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
      });
    });
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Page Title */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Dashboard</h1>
        <p className="text-slate-400 text-sm mt-0.5">
          Real-time inventory health, demand forecasting, and replenishment decisions.
        </p>
      </div>

      {/* 5 Clean KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
        {/* Products */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Products</span>
            <Boxes className="w-4 h-4 text-blue-400" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-white">
            {total_products}
          </div>
          <span className="text-[11px] text-slate-400">Active SKUs tracked</span>
        </div>

        {/* Reorder */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">To Reorder</span>
            <RotateCcw className="w-4 h-4 text-amber-400" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-amber-400">
            {products_to_reorder}
          </div>
          <span className="text-[11px] text-slate-400">Breached ROP point</span>
        </div>

        {/* Stockout Risk */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Stockout Risk</span>
            <AlertTriangle className="w-4 h-4 text-rose-400" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-rose-400">
            {stockout_risk_count}
          </div>
          <span className="text-[11px] text-slate-400">Critical items</span>
        </div>

        {/* Excess Inventory */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Excess Inventory</span>
            <TrendingUp className="w-4 h-4 text-purple-400" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-purple-400">
            {excess_inventory_count}
          </div>
          <span className="text-[11px] text-slate-400">Overstocked buffer</span>
        </div>

        {/* Inventory Value */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-sm flex flex-col justify-between col-span-2 sm:col-span-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Inventory Value</span>
            <IndianRupee className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-emerald-400 font-mono">
            ₹{(total_inventory_value / 100000).toFixed(1)}L
          </div>
          <span className="text-[11px] text-slate-400">On-hand valuation</span>
        </div>
      </div>

      {/* 📈 Demand Forecast Chart (Forecast vs Actual) */}
      <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <h2 className="text-base font-bold text-white">Demand Forecast (Forecast vs Actual)</h2>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {forecastData?.plain_english_summary || 'Demand trajectory combining historical sales and projected velocity.'}
            </p>
          </div>

          {/* SKU Picker */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 font-medium">Select SKU:</span>
            <select
              value={selectedSku}
              onChange={(e) => setSelectedSku(e.target.value)}
              className="bg-slate-950 border border-slate-700 text-xs font-semibold text-slate-100 rounded-lg px-2.5 py-1.5 focus:outline-none cursor-pointer"
            >
              {products.map((p) => (
                <option key={p.product_id} value={p.product_id}>
                  {p.product_id} - {p.product_name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Recharts Curve */}
        {loadingForecast ? (
          <div className="h-64 flex items-center justify-center text-slate-400 text-xs">
            Loading demand curve...
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
                    color: '#f8fafc',
                    fontSize: '12px',
                  }}
                />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                <Line
                  type="monotone"
                  dataKey="Actual"
                  stroke="#94a3b8"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                />
                <Line
                  type="monotone"
                  dataKey="Forecast"
                  stroke="#10b981"
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* ⚠️ Inventory Alerts Section */}
      <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <h2 className="text-base font-bold text-white">Inventory Alerts</h2>
          </div>
          <button
            onClick={() => onNavigateTab('inventory')}
            className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
          >
            <span>View Full Inventory</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="space-y-2.5">
          {alerts.length === 0 ? (
            <p className="text-xs text-slate-400 py-4 text-center">
              All inventory levels are sufficient. No urgent actions needed.
            </p>
          ) : (
            alerts.map((alert) => (
              <div
                key={alert.product_id}
                className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${
                    alert.condition === 'Stockout Risk'
                      ? 'bg-rose-500/10 text-rose-400'
                      : alert.condition === 'Low Stock'
                      ? 'bg-amber-500/10 text-amber-400'
                      : 'bg-purple-500/10 text-purple-400'
                  }`}>
                    <ShieldAlert className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-white">{alert.product_id}</span>
                      <span className="text-xs text-slate-400">— {alert.product_name}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                        alert.condition === 'Stockout Risk'
                          ? 'bg-rose-500/20 text-rose-300'
                          : alert.condition === 'Low Stock'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-purple-500/20 text-purple-300'
                      }`}>
                        {alert.condition}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {alert.message}
                    </p>
                  </div>
                </div>

                {alert.recommended_reorder_qty > 0 && (
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <div className="text-xs font-bold text-white">
                        Reorder: <span className="text-emerald-400 font-mono">{alert.recommended_reorder_qty} units</span>
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {alert.days_of_inventory} days buffer
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        onSelectProduct(alert.product_id);
                        onNavigateTab('inventory');
                      }}
                      className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold transition-colors shadow-sm"
                    >
                      Reorder
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
