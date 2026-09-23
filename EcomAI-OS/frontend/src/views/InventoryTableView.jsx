import React, { useState, useEffect } from 'react';
import {
  Boxes,
  RotateCcw,
  AlertTriangle,
  CheckCircle,
  Truck,
  X,
  PackageCheck,
  TrendingUp,
  Clock,
  ChevronRight,
  Info,
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

export default function InventoryTableView({
  products = [],
  selectedProductId,
  onSelectProduct,
  onOrderPlaced,
}) {
  const [activeModalProduct, setActiveModalProduct] = useState(null);
  const [modalForecast, setModalForecast] = useState(null);
  const [loadingForecast, setLoadingForecast] = useState(false);
  const [orderExecuted, setOrderExecuted] = useState(false);

  useEffect(() => {
    if (selectedProductId && !activeModalProduct) {
      const match = products.find((p) => p.product_id === selectedProductId);
      if (match) setActiveModalProduct(match);
    }
  }, [selectedProductId, products]);

  const openProductDetails = (product) => {
    setActiveModalProduct(product);
    onSelectProduct(product.product_id);
    setOrderExecuted(false);
    setLoadingForecast(true);
    generateForecast(product.product_id, 30)
      .then(setModalForecast)
      .catch(console.error)
      .finally(() => setLoadingForecast(false));
  };

  const handleExecuteOrder = (qty) => {
    setOrderExecuted(true);
    if (onOrderPlaced) {
      onOrderPlaced(qty);
    }
  };

  // Forecast chart data for details modal
  const modalChartData = [];
  if (modalForecast) {
    modalForecast.recent_actuals?.slice(-14).forEach((pt) => {
      modalChartData.push({
        date: pt.date,
        Actual: pt.units_sold,
      });
    });
    modalForecast.forecast_points?.forEach((pt) => {
      modalChartData.push({
        date: pt.date,
        Forecast: pt.forecast_units,
      });
    });
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Inventory</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            Monitor current stock against projected 30-day demand and automate replenishment decisions.
          </p>
        </div>
      </div>

      {/* Main Inventory Table */}
      <div className="rounded-2xl bg-slate-900 border border-slate-800 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-950 text-slate-400 uppercase text-xs tracking-wider border-b border-slate-800 font-semibold">
              <tr>
                <th className="py-3.5 px-5">Product</th>
                <th className="py-3.5 px-4 text-right">Stock</th>
                <th className="py-3.5 px-4 text-right">30d Forecast</th>
                <th className="py-3.5 px-4 text-right">Reorder Point</th>
                <th className="py-3.5 px-4 text-center">Decision</th>
                <th className="py-3.5 px-4 text-right">Order Qty</th>
                <th className="py-3.5 px-5 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 font-medium">
              {products.map((p) => {
                const isReorder = p.decision === 'REORDER';
                const isMonitor = p.decision === 'MONITOR';

                return (
                  <tr
                    key={p.product_id}
                    onClick={() => openProductDetails(p)}
                    className="hover:bg-slate-800/50 cursor-pointer transition-colors"
                  >
                    {/* Product */}
                    <td className="py-3.5 px-5">
                      <div className="font-bold text-white">{p.product_name}</div>
                      <div className="text-xs text-slate-500 font-mono">
                        {p.product_id} • {p.category}
                      </div>
                    </td>

                    {/* Stock */}
                    <td className="py-3.5 px-4 text-right font-bold text-white font-mono">
                      {p.current_stock}
                    </td>

                    {/* Forecast */}
                    <td className="py-3.5 px-4 text-right text-slate-300 font-mono">
                      {p.total_30d_forecast || Math.round(p.historical_daily_avg * 30)}
                    </td>

                    {/* Reorder Point */}
                    <td className="py-3.5 px-4 text-right text-slate-400 font-mono">
                      {Math.round(p.reorder_point)}
                    </td>

                    {/* Decision */}
                    <td className="py-3.5 px-4 text-center">
                      <span
                        className={`inline-block px-3 py-1 rounded-full text-xs font-bold ${
                          isReorder
                            ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                            : isMonitor
                            ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                            : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                        }`}
                      >
                        {p.decision_badge}
                      </span>
                    </td>

                    {/* Order Qty */}
                    <td className="py-3.5 px-4 text-right font-mono font-bold">
                      {isReorder && p.recommended_order_qty > 0 ? (
                        <span className="text-rose-400">{p.recommended_order_qty} u</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>

                    {/* Action */}
                    <td className="py-3.5 px-5 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openProductDetails(p);
                        }}
                        className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 transition-colors inline-flex items-center gap-1"
                      >
                        <span>Details</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Product Details Drawer / Modal */}
      {activeModalProduct && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl shadow-2xl p-6 relative max-h-[90vh] overflow-y-auto animate-fadeIn">
            {/* Close Button */}
            <button
              onClick={() => setActiveModalProduct(null)}
              className="absolute top-5 right-5 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Header */}
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                  {activeModalProduct.product_id}
                </span>
                <span className="text-xs text-slate-400 font-medium">
                  {activeModalProduct.category}
                </span>
              </div>
              <h2 className="text-xl font-extrabold text-white mt-1">
                {activeModalProduct.product_id} — {activeModalProduct.product_name}
              </h2>
            </div>

            {/* Quick Specs Grid */}
            <div className="mt-5 grid grid-cols-2 sm:grid-cols-5 gap-3 p-4 rounded-xl bg-slate-950 border border-slate-800 text-xs">
              <div>
                <span className="text-slate-400 block">Current Stock</span>
                <span className="font-extrabold text-base text-white font-mono mt-0.5 block">
                  {activeModalProduct.current_stock}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">30-Day Forecast</span>
                <span className="font-extrabold text-base text-blue-400 font-mono mt-0.5 block">
                  {activeModalProduct.total_30d_forecast || Math.round(activeModalProduct.historical_daily_avg * 30)}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Safety Stock</span>
                <span className="font-extrabold text-base text-amber-400 font-mono mt-0.5 block">
                  {Math.round(activeModalProduct.safety_stock)}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Reorder Point</span>
                <span className="font-extrabold text-base text-purple-400 font-mono mt-0.5 block">
                  {Math.round(activeModalProduct.reorder_point)}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Lead Time</span>
                <span className="font-extrabold text-base text-white font-mono mt-0.5 block">
                  {activeModalProduct.lead_time_days} days
                </span>
              </div>
            </div>

            {/* Demand Forecast Curve (Actual vs Forecast) */}
            <div className="mt-5 p-4 rounded-xl bg-slate-950 border border-slate-800">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-white flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                  Demand Forecast (Actual ───── Forecast)
                </span>
              </div>
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={modalChartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 10 }} />
                    <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#0f172a',
                        borderColor: '#334155',
                        borderRadius: '0.5rem',
                        fontSize: '11px',
                      }}
                    />
                    <Line type="monotone" dataKey="Actual" stroke="#94a3b8" strokeWidth={2} dot={{ r: 1.5 }} />
                    <Line type="monotone" dataKey="Forecast" stroke="#10b981" strokeWidth={2} dot={{ r: 2 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Recommendation Box */}
            <div className="mt-5 p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">
                Recommendation
              </span>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="text-base font-extrabold text-white">
                  {activeModalProduct.decision === 'REORDER' ? (
                    <span className="text-rose-400">
                      🔴 Reorder {activeModalProduct.recommended_order_qty} units
                    </span>
                  ) : activeModalProduct.decision === 'MONITOR' ? (
                    <span className="text-amber-400">
                      🟡 Monitor Demand (Reorder not yet breached)
                    </span>
                  ) : (
                    <span className="text-emerald-400">
                      🟢 No Reorder Needed (Adequate Stock)
                    </span>
                  )}
                </div>

                {activeModalProduct.recommended_order_qty > 0 && !orderExecuted && (
                  <button
                    onClick={() => handleExecuteOrder(activeModalProduct.recommended_order_qty)}
                    className="py-2 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors shadow-md"
                  >
                    <Truck className="w-4 h-4" />
                    <span>Create Purchase Order</span>
                  </button>
                )}

                {orderExecuted && (
                  <div className="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-bold flex items-center gap-1.5">
                    <PackageCheck className="w-4 h-4" />
                    <span>Order Placed!</span>
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-400">
                {activeModalProduct.plain_english_insight}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
