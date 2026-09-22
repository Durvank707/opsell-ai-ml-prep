import React from 'react';
import {
  Boxes,
  IndianRupee,
  ShieldCheck,
  AlertTriangle,
  ArrowUpRight,
  TrendingUp,
  Clock,
  CheckCircle,
  Truck,
} from 'lucide-react';

export default function OverviewView({
  overviewData,
  onSelectProduct,
  onNavigateTab,
}) {
  if (!overviewData) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400">
        Loading executive metrics...
      </div>
    );
  }

  const {
    total_products,
    total_inventory_units,
    total_inventory_value,
    high_risk_count,
    medium_risk_count,
    low_risk_count,
    portfolio_service_level,
    products = [],
  } = overviewData;

  const urgentProducts = products.filter(
    (p) => p.stockout_risk === 'HIGH' || p.stockout_risk === 'MEDIUM'
  );

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Top Welcome & KPI row */}
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">
          Executive Inventory & Demand Overview
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          Real-time visibility across portfolio stock positions, machine learning demand velocity, and autonomous stockout alerts.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Inventory Units */}
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Total On-Hand Stock
            </span>
            <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
              <Boxes className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white">
              {total_inventory_units.toLocaleString()}
            </span>
            <span className="text-xs text-slate-400">units</span>
          </div>
          <p className="text-xs text-slate-400 mt-2">Across {total_products} active product categories</p>
        </div>

        {/* Portfolio Valuation */}
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Portfolio Valuation
            </span>
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <IndianRupee className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white">
              ₹{(total_inventory_value / 100000).toFixed(2)}L
            </span>
            <span className="text-xs text-slate-400">(@ unit cost)</span>
          </div>
          <p className="text-xs text-emerald-400 mt-2">Optimal capital deployment</p>
        </div>

        {/* Portfolio Service Level */}
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Portfolio Service Level
            </span>
            <div className="p-2 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20">
              <ShieldCheck className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white">
              {portfolio_service_level}%
            </span>
            <span className="text-xs text-purple-300 font-medium">Target ≥ 99.0%</span>
          </div>
          <p className="text-xs text-slate-400 mt-2">Order fulfillment success rate</p>
        </div>

        {/* Risk Alerts */}
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Stockout Risk Status
            </span>
            <div className={`p-2 rounded-xl border ${
              high_risk_count > 0
                ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
            }`}>
              <AlertTriangle className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-3">
            <span className="text-3xl font-extrabold text-white">
              {high_risk_count}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 font-semibold border border-rose-500/30">
              High Risk
            </span>
            <span className="text-xs text-slate-400">
              {low_risk_count} Stable
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            {high_risk_count > 0 ? 'Requires immediate replenishment' : 'All SKUs adequately stocked'}
          </p>
        </div>
      </div>

      {/* Urgent Replenishment Alert Banner */}
      {urgentProducts.length > 0 && (
        <div className="p-5 rounded-2xl bg-gradient-to-r from-rose-950/40 via-slate-900/80 to-slate-900/60 border border-rose-500/30 shadow-lg">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-rose-400" />
              <h2 className="text-base font-bold text-white">
                Urgent Replenishment Alerts ({urgentProducts.length} SKUs At Risk)
              </h2>
            </div>
            <span className="text-xs font-mono text-rose-300 bg-rose-500/15 border border-rose-500/20 px-2 py-0.5 rounded-md">
              High Priority
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {urgentProducts.map((p) => (
              <div
                key={p.product_id}
                className="p-3.5 rounded-xl bg-slate-900/90 border border-rose-500/20 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white">{p.product_name}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                      {p.product_id}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-slate-300">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Current Stock:</span>
                      <span className="font-semibold text-rose-400">{p.current_stock} units</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Days of Inventory:</span>
                      <span className="font-mono">{p.days_of_inventory} days</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Supplier Lead Time:</span>
                      <span>{p.lead_time_days} days</span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => {
                    onSelectProduct(p.product_id);
                    onNavigateTab('inventory');
                  }}
                  className="mt-3 w-full py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                >
                  <span>Review PO Recommendation</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Portfolio Products Table */}
      <div className="rounded-2xl bg-slate-900/70 border border-slate-800 overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-white">SKU Inventory & Demand Velocity</h2>
            <p className="text-xs text-slate-400">Live operational snapshot across tracked inventory</p>
          </div>
          <button
            onClick={() => onNavigateTab('forecast')}
            className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
          >
            <span>Launch Demand Forecasts</span>
            <ArrowUpRight className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/60 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">SKU / Name</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4 text-right">Selling Price</th>
                <th className="py-3 px-4 text-right">On Hand</th>
                <th className="py-3 px-4 text-right">Daily Velocity</th>
                <th className="py-3 px-4 text-right">Safety Stock</th>
                <th className="py-3 px-4 text-right">Reorder Point</th>
                <th className="py-3 px-4 text-center">DOI</th>
                <th className="py-3 px-4 text-center">Risk Level</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-medium">
              {products.map((p) => {
                const isHigh = p.stockout_risk === 'HIGH';
                const isMed = p.stockout_risk === 'MEDIUM';

                return (
                  <tr
                    key={p.product_id}
                    className="hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-100">{p.product_name}</div>
                      <div className="text-[11px] font-mono text-slate-500">{p.product_id}</div>
                    </td>
                    <td className="py-3 px-4 text-slate-400">{p.category}</td>
                    <td className="py-3 px-4 text-right text-slate-200 font-mono">
                      ₹{p.unit_price.toFixed(0)}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-white">
                      {p.current_stock}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-300 font-mono">
                      ~{p.historical_daily_avg} u/day
                    </td>
                    <td className="py-3 px-4 text-right text-slate-400 font-mono">
                      {p.safety_stock}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-400 font-mono">
                      {p.reorder_point}
                    </td>
                    <td className="py-3 px-4 text-center font-mono">
                      <span className={`px-2 py-0.5 rounded text-[11px] ${
                        p.days_of_inventory < 5
                          ? 'bg-rose-500/20 text-rose-300 font-bold'
                          : 'text-slate-300'
                      }`}>
                        {p.days_of_inventory}d
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold border uppercase tracking-wider ${
                          isHigh
                            ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                            : isMed
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                            : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        }`}
                      >
                        {p.stockout_risk}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => {
                            onSelectProduct(p.product_id);
                            onNavigateTab('forecast');
                          }}
                          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] transition-colors"
                          title="View ML Forecast"
                        >
                          Forecast
                        </button>
                        <button
                          onClick={() => {
                            onSelectProduct(p.product_id);
                            onNavigateTab('inventory');
                          }}
                          className="px-2 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-[11px] font-semibold transition-colors"
                          title="Manage Inventory"
                        >
                          Reorder
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
