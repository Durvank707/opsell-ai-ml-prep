import React, { useState, useEffect } from 'react';
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
import {
  FlaskConical,
  Play,
  RotateCw,
  ShieldCheck,
  TrendingDown,
  AlertTriangle,
  IndianRupee,
  Calendar,
  Layers,
} from 'lucide-react';
import { runBacktest } from '../api/client';

export default function SimulationView({
  products = [],
  selectedProductId,
  onSelectProduct,
}) {
  const [selectedSku, setSelectedSku] = useState(selectedProductId || 'P001');
  const [startDate, setStartDate] = useState('2025-10-01');
  const [endDate, setEndDate] = useState('2025-12-31');
  const [policyMode, setPolicyMode] = useState('current'); // 'current', 'conservative', 'aggressive'
  const [loading, setLoading] = useState(false);
  const [simResult, setSimResult] = useState(null);
  const [error, setError] = useState(null);

  const handleRunSimulation = async (mode = policyMode) => {
    if (!selectedSku) return;
    setLoading(true);
    setError(null);
    try {
      const data = await runBacktest({
        product_id: selectedSku,
        start_date: startDate,
        end_date: endDate,
        policy_mode: mode,
        holding_cost_rate: 0.20,
        ordering_cost_per_order: 500,
        stockout_cost_per_unit: 1000,
      });
      setSimResult(data);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Simulation failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    handleRunSimulation(policyMode);
  }, [selectedSku]);

  const handlePolicyChange = (newMode) => {
    setPolicyMode(newMode);
    handleRunSimulation(newMode);
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Simulation — V2</h1>
        <p className="text-slate-400 text-sm mt-0.5">
          Simulate and stress-test inventory policies against real historical demand before deployment.
        </p>
      </div>

      {/* Control Box: Period & Policy Selector */}
      <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
          {/* SKU Picker */}
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-1.5">
              Select Product:
            </label>
            <select
              value={selectedSku}
              onChange={(e) => {
                setSelectedSku(e.target.value);
                onSelectProduct(e.target.value);
              }}
              className="w-full bg-slate-950 border border-slate-700 text-xs font-semibold text-slate-100 rounded-xl px-3 py-2.5 focus:outline-none cursor-pointer"
            >
              {products.map((p) => (
                <option key={p.product_id} value={p.product_id}>
                  {p.product_id} — {p.product_name}
                </option>
              ))}
            </select>
          </div>

          {/* Simulation Period */}
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-1.5">
              Simulation Period:
            </label>
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-slate-200">
              <Calendar className="w-4 h-4 text-emerald-400" />
              <span>Oct 2025 → Dec 2025 (92 Days)</span>
            </div>
          </div>

          {/* Run Action */}
          <div>
            <button
              onClick={() => handleRunSimulation(policyMode)}
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 transition-colors shadow-md"
            >
              {loading ? (
                <RotateCw className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4 fill-current" />
              )}
              <span>Run Simulation</span>
            </button>
          </div>
        </div>

        {/* Inventory Policy Radio Buttons */}
        <div className="mt-5 pt-4 border-t border-slate-800">
          <label className="text-xs font-semibold text-slate-400 block mb-2">
            Inventory Policy:
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              {
                id: 'current',
                label: 'Current Policy',
                desc: 'Standard ML replenishment (Target 95% SL)',
              },
              {
                id: 'conservative',
                label: 'Conservative',
                desc: 'Higher safety stock buffer (Target 98% SL, near zero stockouts)',
              },
              {
                id: 'aggressive',
                label: 'Aggressive',
                desc: 'Ultra-lean inventory (Target 90% SL, lower holding capital)',
              },
            ].map((p) => (
              <label
                key={p.id}
                onClick={() => handlePolicyChange(p.id)}
                className={`p-3.5 rounded-xl border cursor-pointer transition-all flex items-start gap-3 ${
                  policyMode === p.id
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                }`}
              >
                <input
                  type="radio"
                  name="policy"
                  value={p.id}
                  checked={policyMode === p.id}
                  onChange={() => handlePolicyChange(p.id)}
                  className="mt-0.5 accent-emerald-500"
                />
                <div>
                  <div className="text-xs font-bold text-white">{p.label}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">{p.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs">
          {error}
        </div>
      )}

      {/* Simulation Results Section */}
      {simResult && (
        <div className="space-y-4">
          <div className="text-center sm:text-left">
            <h2 className="text-lg font-bold text-white">Simulation Results</h2>
            <p className="text-xs text-slate-400">
              Performance metrics for {simResult.product_id} under <span className="font-semibold text-white capitalize">{simResult.policy_mode}</span> strategy.
            </p>
          </div>

          {/* 3 Result Scorecards + Inventory Cost */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Stockouts */}
            <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-center">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">
                Stockouts
              </span>
              <div className="text-3xl font-extrabold text-rose-400 mt-2 font-mono">
                {simResult.stockouts_count}
              </div>
              <span className="text-[11px] text-slate-500">Days out of stock</span>
            </div>

            {/* Excess Stock */}
            <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-center">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">
                Excess Stock
              </span>
              <div className="text-3xl font-extrabold text-purple-400 mt-2 font-mono">
                {simResult.excess_stock_units}
              </div>
              <span className="text-[11px] text-slate-500">Avg buffer units</span>
            </div>

            {/* Service Level */}
            <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-center">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">
                Service Level
              </span>
              <div className="text-3xl font-extrabold text-emerald-400 mt-2 font-mono">
                {simResult.service_level}%
              </div>
              <span className="text-[11px] text-slate-500">Order fill rate</span>
            </div>

            {/* Inventory Cost */}
            <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-center">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block flex items-center justify-center gap-1">
                <span>Inventory Cost</span>
              </span>
              <div className="text-3xl font-extrabold text-white mt-2 font-mono">
                ₹{Math.round(simResult.total_inventory_cost).toLocaleString()}
              </div>
              <span className="text-[11px] text-emerald-400 font-semibold">
                {simResult.cost_savings >= 0
                  ? `₹${Math.round(simResult.cost_savings).toLocaleString()} saved vs Baseline`
                  : 'Higher stockout protection'}
              </span>
            </div>
          </div>

          {/* Policy Comparison Chart */}
          <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-bold text-white">Policy Trajectory (Stock Behavior)</h3>
                <p className="text-xs text-slate-400">
                  Daily closing inventory under selected policy vs standard static baseline.
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs font-semibold">
                <span className="text-emerald-400 flex items-center gap-1.5">
                  <span className="w-3 h-0.5 bg-emerald-400"></span>
                  Selected Policy ({simResult.policy_mode})
                </span>
                <span className="text-purple-400 flex items-center gap-1.5">
                  <span className="w-3 h-0.5 bg-purple-400"></span>
                  Static Moving Average
                </span>
              </div>
            </div>

            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={simResult.daily_trajectory} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
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
                  <Line
                    type="monotone"
                    dataKey="policy_closing_stock"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    name="Selected Policy Stock"
                  />
                  <Line
                    type="monotone"
                    dataKey="baseline_closing_stock"
                    stroke="#c084fc"
                    strokeWidth={1.5}
                    strokeDasharray="3 3"
                    dot={false}
                    name="Baseline Stock"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
