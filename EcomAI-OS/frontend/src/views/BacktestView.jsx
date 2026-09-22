import React, { useState, useEffect } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';
import {
  Cpu,
  TrendingDown,
  Percent,
  IndianRupee,
  ShieldCheck,
  Package,
  Layers,
  Sparkles,
  ArrowRight,
  Play,
  RotateCw,
} from 'lucide-react';
import { runBacktest } from '../api/client';

export default function BacktestView({
  products,
  selectedProductId,
  onSelectProduct,
}) {
  const currentProduct = products.find((p) => p.product_id === selectedProductId);

  const [startDate, setStartDate] = useState('2025-10-01');
  const [endDate, setEndDate] = useState('2025-12-31');
  const [holdingRate, setHoldingRate] = useState(0.20);
  const [orderingCost, setOrderingCost] = useState(500);
  const [stockoutCost, setStockoutCost] = useState(1000);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const executeBacktest = async () => {
    if (!selectedProductId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await runBacktest({
        product_id: selectedProductId,
        start_date: startDate,
        end_date: endDate,
        holding_cost_rate: Number(holdingRate),
        ordering_cost_per_order: Number(orderingCost),
        stockout_cost_per_unit: Number(stockoutCost),
      });
      setResult(data);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Simulation failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    executeBacktest();
  }, [selectedProductId]);

  const costBreakdownData = result
    ? [
        {
          name: 'Holding Cost',
          XGBoost: result.xgb_metrics.holding_cost,
          Baseline: result.baseline_metrics.holding_cost,
        },
        {
          name: 'Ordering Cost',
          XGBoost: result.xgb_metrics.ordering_cost,
          Baseline: result.baseline_metrics.ordering_cost,
        },
        {
          name: 'Stockout Penalty',
          XGBoost: result.xgb_metrics.stockout_cost,
          Baseline: result.baseline_metrics.stockout_cost,
        },
        {
          name: 'Total Cost',
          XGBoost: result.xgb_metrics.total_inventory_cost,
          Baseline: result.baseline_metrics.total_inventory_cost,
        },
      ]
    : [];

  const savings = result
    ? result.baseline_metrics.total_inventory_cost - result.xgb_metrics.total_inventory_cost
    : 0;
  const savingsPct = result && result.baseline_metrics.total_inventory_cost > 0
    ? (savings / result.baseline_metrics.total_inventory_cost) * 100
    : 0;

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-extrabold text-white tracking-tight">
              Digital Twin Backtesting & ROI Simulator
            </h1>
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              Historical Verification
            </span>
          </div>
          <p className="text-slate-400 text-sm mt-1">
            Compare autonomous ML replenishment against static Moving Average baseline across 92 days of historical demand.
          </p>
        </div>
      </div>

      {/* Simulator Parameters Bar */}
      <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
            Supply Chain Cost Parameters
          </span>
          <span className="text-xs text-slate-500 font-mono">
            Backtest: {startDate} to {endDate}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
          <div>
            <label className="text-xs text-slate-400 block mb-1">
              Annual Holding Cost Rate:
            </label>
            <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white">
              <input
                type="number"
                step="0.05"
                min="0.05"
                max="0.50"
                value={holdingRate}
                onChange={(e) => setHoldingRate(e.target.value)}
                className="bg-transparent w-full focus:outline-none font-mono"
              />
              <span className="text-slate-500 font-semibold">% / yr</span>
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-400 block mb-1">
              PO Ordering Cost (₹ / order):
            </label>
            <input
              type="number"
              step="50"
              value={orderingCost}
              onChange={(e) => setOrderingCost(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="text-xs text-slate-400 block mb-1">
              Stockout Penalty (₹ / lost unit):
            </label>
            <input
              type="number"
              step="100"
              value={stockoutCost}
              onChange={(e) => setStockoutCost(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
            />
          </div>

          <button
            onClick={executeBacktest}
            disabled={loading}
            className="w-full py-2 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 shadow-md shadow-emerald-500/10 transition-colors"
          >
            {loading ? (
              <RotateCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4 fill-current" />
            )}
            <span>Run Digital Twin</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs">
          {error}
        </div>
      )}

      {/* KPI Comparison Cards */}
      {result && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Net Financial Savings */}
          <div className="p-5 rounded-2xl bg-gradient-to-br from-emerald-950/40 via-slate-900 to-slate-900/80 border border-emerald-500/30 shadow-sm">
            <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              Net Policy Savings
            </span>
            <div className="mt-3 flex items-baseline gap-2">
              <span className={`text-3xl font-extrabold ${savings >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                ₹{Math.abs(savings).toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
              <span className="text-xs font-mono text-slate-400">
                {savings >= 0 ? `(${savingsPct.toFixed(1)}% savings)` : '(Higher buffer)'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-2">
              Total Supply Chain Cost reduced vs MA
            </p>
          </div>

          {/* Service Level Comparison */}
          <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 shadow-sm">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Service Level Achieved
            </span>
            <div className="mt-3 flex items-baseline justify-between">
              <div>
                <div className="text-2xl font-extrabold text-emerald-400">
                  {result.xgb_metrics.service_level}%
                </div>
                <span className="text-[10px] text-slate-500 font-mono">XGBoost ML</span>
              </div>
              <div className="text-slate-600 text-sm font-bold">vs</div>
              <div className="text-right">
                <div className="text-2xl font-extrabold text-purple-400">
                  {result.baseline_metrics.service_level}%
                </div>
                <span className="text-[10px] text-slate-500 font-mono">Moving Avg</span>
              </div>
            </div>
          </div>

          {/* Average Stock Position */}
          <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 shadow-sm">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Average Inventory
            </span>
            <div className="mt-3 flex items-baseline justify-between">
              <div>
                <div className="text-2xl font-extrabold text-emerald-400">
                  {result.xgb_metrics.average_inventory.toFixed(0)} u
                </div>
                <span className="text-[10px] text-slate-500 font-mono">Lean ML Buffer</span>
              </div>
              <div className="text-slate-600 text-sm font-bold">vs</div>
              <div className="text-right">
                <div className="text-2xl font-extrabold text-purple-400">
                  {result.baseline_metrics.average_inventory.toFixed(0)} u
                </div>
                <span className="text-[10px] text-slate-500 font-mono">Overstocked MA</span>
              </div>
            </div>
          </div>

          {/* Total Purchase Orders */}
          <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 shadow-sm">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Orders Placed
            </span>
            <div className="mt-3 flex items-baseline justify-between">
              <div>
                <div className="text-2xl font-extrabold text-white">
                  {result.xgb_metrics.number_of_orders}
                </div>
                <span className="text-[10px] text-slate-500 font-mono">XGBoost Orders</span>
              </div>
              <div className="text-slate-600 text-sm font-bold">vs</div>
              <div className="text-right">
                <div className="text-2xl font-extrabold text-slate-300">
                  {result.baseline_metrics.number_of_orders}
                </div>
                <span className="text-[10px] text-slate-500 font-mono">Baseline Orders</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Trajectory & Cost breakdown Charts */}
      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Daily Closing Stock Curve */}
          <div className="lg:col-span-2 p-5 rounded-2xl bg-slate-900/70 border border-slate-800">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-bold text-white">
                  Closing Inventory Trajectory (92 Days Backtest)
                </h2>
                <p className="text-xs text-slate-400">
                  Visualizing stock levels under XGBoost order decisions vs Moving Average.
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                  <span className="w-3 h-0.5 bg-emerald-400 inline-block"></span>
                  XGBoost
                </span>
                <span className="flex items-center gap-1.5 text-purple-400">
                  <span className="w-3 h-0.5 bg-purple-400 inline-block"></span>
                  Baseline MA
                </span>
              </div>
            </div>

            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={result.daily_trajectory} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
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
                  <Line
                    type="monotone"
                    dataKey="xgb_closing_stock"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    name="XGBoost Closing Stock"
                  />
                  <Line
                    type="monotone"
                    dataKey="baseline_closing_stock"
                    stroke="#c084fc"
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    dot={false}
                    name="Baseline Closing Stock"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Financial Breakdown Bar Chart */}
          <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800">
            <h2 className="text-base font-bold text-white mb-1">
              Financial Supply Chain Cost
            </h2>
            <p className="text-xs text-slate-400 mb-4">
              Breakdown of holding, ordering, & stockout costs.
            </p>

            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={costBreakdownData} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="name" stroke="#64748b" tick={{ fontSize: 10 }} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0f172a',
                      borderColor: '#334155',
                      borderRadius: '0.75rem',
                      color: '#f8fafc',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="XGBoost" fill="#10b981" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Baseline" fill="#a855f7" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
