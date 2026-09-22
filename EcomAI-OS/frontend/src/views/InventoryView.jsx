import React, { useState, useEffect } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';
import {
  Boxes,
  AlertTriangle,
  CheckCircle,
  Truck,
  PackageCheck,
  Calculator,
  Calendar,
  Layers,
  ShoppingBag,
  IndianRupee,
} from 'lucide-react';
import { fetchReorderRecommendation, fetchStockoutTimeline } from '../api/client';

export default function InventoryView({
  products,
  selectedProductId,
  onSelectProduct,
  onOrderPlaced,
}) {
  const currentProduct = products.find((p) => p.product_id === selectedProductId);

  const [moq, setMoq] = useState(0);
  const [packSize, setPackSize] = useState(1);
  const [reorderData, setReorderData] = useState(null);
  const [timelineData, setTimelineData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [orderConfirmed, setOrderConfirmed] = useState(false);

  const loadData = async () => {
    if (!selectedProductId) return;
    setLoading(true);
    try {
      const [reorder, timeline] = await Promise.all([
        fetchReorderRecommendation(selectedProductId, moq, packSize),
        fetchStockoutTimeline(selectedProductId),
      ]);
      setReorderData(reorder);
      setTimelineData(timeline);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    setOrderConfirmed(false);
  }, [selectedProductId, moq, packSize]);

  const handleCreatePO = () => {
    setOrderConfirmed(true);
    if (onOrderPlaced && reorderData) {
      onOrderPlaced(reorderData.recommended_order_qty);
    }
  };

  const chartData = timelineData?.timeline?.map((pt) => ({
    date: pt.date,
    projectedStock: Math.max(0, pt.projected_stock),
    cumulativeDemand: pt.cumulative_demand,
  })) || [];

  const isHighRisk = reorderData?.stockout_risk === 'HIGH';
  const isMedRisk = reorderData?.stockout_risk === 'MEDIUM';

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-extrabold text-white tracking-tight">
              Inventory & Reorder Intelligence
            </h1>
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-bold border uppercase tracking-wider ${
                isHighRisk
                  ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                  : isMedRisk
                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                  : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
              }`}
            >
              {reorderData?.stockout_risk || 'LOW'} Risk
            </span>
          </div>
          <p className="text-slate-400 text-sm mt-1">
            Dynamic Safety Stock, Reorder Point (ROP) thresholds, and supplier batching calculators.
          </p>
        </div>
      </div>

      {/* Snapshot Cards */}
      {reorderData && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              On-Hand Stock
            </span>
            <div className="mt-1 text-xl font-extrabold text-white">
              {reorderData.current_stock} <span className="text-xs text-slate-500">u</span>
            </div>
            <span className="text-[10px] text-slate-400">Physical inventory</span>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Open POs in Transit
            </span>
            <div className="mt-1 text-xl font-extrabold text-blue-400">
              {reorderData.open_order_qty} <span className="text-xs text-slate-500">u</span>
            </div>
            <span className="text-[10px] text-slate-400">Confirmed shipments</span>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Inventory Position
            </span>
            <div className="mt-1 text-xl font-extrabold text-emerald-400">
              {reorderData.inventory_position} <span className="text-xs text-slate-500">u</span>
            </div>
            <span className="text-[10px] text-slate-400">Stock + Open Orders</span>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Safety Stock
            </span>
            <div className="mt-1 text-xl font-extrabold text-amber-400">
              {reorderData.safety_stock} <span className="text-xs text-slate-500">u</span>
            </div>
            <span className="text-[10px] text-slate-400">Buffer @ 95% SL</span>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Reorder Point (ROP)
            </span>
            <div className="mt-1 text-xl font-extrabold text-purple-400">
              {reorderData.reorder_point} <span className="text-xs text-slate-500">u</span>
            </div>
            <span className="text-[10px] text-slate-400">Lead-time + SS</span>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Supplier Lead Time
            </span>
            <div className="mt-1 text-xl font-extrabold text-white">
              {reorderData.lead_time_days} <span className="text-xs text-slate-500">days</span>
            </div>
            <span className="text-[10px] text-slate-400">Order-to-dock cycle</span>
          </div>
        </div>
      )}

      {/* Main Grid: Stockout Projection & Reorder Calculator */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Stockout Depletion Timeline Chart */}
        <div className="lg:col-span-2 p-5 rounded-2xl bg-slate-900/70 border border-slate-800 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-bold text-white">
                  30-Day Stock Depletion Projection
                </h2>
                <p className="text-xs text-slate-400">
                  Forecast demand consuming current stock position over time.
                </p>
              </div>
              <div className="text-right">
                {timelineData?.expected_stockout_date ? (
                  <span className="text-xs font-bold text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2.5 py-1 rounded-md">
                    Stockout Expected: {timelineData.expected_stockout_date}
                  </span>
                ) : (
                  <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-md">
                    No Stockout Projected within 30d
                  </span>
                )}
              </div>
            </div>

            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="stockGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
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
                  {reorderData && (
                    <ReferenceLine
                      y={reorderData.reorder_point}
                      stroke="#c084fc"
                      strokeDasharray="3 3"
                      label={{
                        value: `ROP (${reorderData.reorder_point})`,
                        fill: '#c084fc',
                        fontSize: 10,
                        position: 'insideTopRight',
                      }}
                    />
                  )}
                  {reorderData && (
                    <ReferenceLine
                      y={reorderData.safety_stock}
                      stroke="#f59e0b"
                      strokeDasharray="3 3"
                      label={{
                        value: `Safety Stock (${reorderData.safety_stock})`,
                        fill: '#f59e0b',
                        fontSize: 10,
                        position: 'insideBottomRight',
                      }}
                    />
                  )}
                  <Area
                    type="monotone"
                    dataKey="projectedStock"
                    stroke="#10b981"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#stockGrad)"
                    name="Projected Stock On Hand"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="mt-3 p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
              Inventory trajectory matches ML demand profile.
            </span>
            <span>ROP Trigger: Breached when Stock drops below {reorderData?.reorder_point} units</span>
          </div>
        </div>

        {/* Right: Policy & Supplier Batching Order Calculator */}
        <div className="p-5 rounded-2xl bg-gradient-to-b from-slate-900 to-slate-900/60 border border-slate-800 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Calculator className="w-4 h-4" />
              </div>
              <h2 className="text-base font-bold text-white">Replenishment Engine</h2>
            </div>

            {/* Reorder Status Alert Box */}
            {reorderData && (
              <div
                className={`p-3.5 rounded-xl border mb-4 ${
                  reorderData.reorder_required
                    ? 'bg-rose-500/15 border-rose-500/30 text-rose-200'
                    : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200'
                }`}
              >
                <div className="flex items-center gap-2 font-bold text-xs">
                  {reorderData.reorder_required ? (
                    <>
                      <AlertTriangle className="w-4 h-4 text-rose-400" />
                      <span>REORDER TRIGGER BREACHED</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                      <span>STOCK SUFFICIENT (ABOVE ROP)</span>
                    </>
                  )}
                </div>
                <p className="text-[11px] mt-1 text-slate-300">
                  {reorderData.reorder_required
                    ? `Inventory position (${reorderData.inventory_position} u) is below ROP threshold (${reorderData.reorder_point} u). Order recommended.`
                    : `Current position (${reorderData.inventory_position} u) safely exceeds reorder point (${reorderData.reorder_point} u).`}
                </p>
              </div>
            )}

            {/* Supplier Parameters: MOQ and Pack Size */}
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">
                  Supplier Minimum Order Quantity (MOQ):
                </label>
                <input
                  type="number"
                  min="0"
                  step="10"
                  value={moq}
                  onChange={(e) => setMoq(Math.max(0, parseInt(e.target.value) || 0))}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">
                  Packaging / Master Carton Size:
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={packSize}
                  onChange={(e) => setPackSize(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
                />
              </div>

              {/* Calculations breakdown */}
              {reorderData && (
                <div className="pt-2 border-t border-slate-800 space-y-1.5 text-xs">
                  <div className="flex justify-between text-slate-400">
                    <span>Target Inventory:</span>
                    <span className="font-mono text-slate-200">{reorderData.target_inventory} u</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Current Inventory Position:</span>
                    <span className="font-mono text-slate-200">{reorderData.inventory_position} u</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Supplier Unit Cost:</span>
                    <span className="font-mono text-slate-200">₹{reorderData.unit_cost}</span>
                  </div>
                  <div className="flex justify-between font-bold text-white pt-1 border-t border-slate-800/80">
                    <span>Recommended PO Qty:</span>
                    <span className="text-emerald-400 text-sm font-mono">
                      {reorderData.recommended_order_qty} units
                    </span>
                  </div>
                  <div className="flex justify-between font-bold text-slate-300">
                    <span>Estimated PO Capital:</span>
                    <span className="text-white font-mono">
                      ₹{reorderData.estimated_order_cost.toLocaleString()}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="mt-5">
            {orderConfirmed ? (
              <div className="p-3 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-semibold flex items-center justify-center gap-2">
                <PackageCheck className="w-4 h-4" />
                <span>PO Dispatched to Supplier!</span>
              </div>
            ) : (
              <button
                onClick={handleCreatePO}
                disabled={!reorderData || reorderData.recommended_order_qty === 0}
                className="w-full py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-950 font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10 transition-colors"
              >
                <Truck className="w-4 h-4" />
                <span>
                  {reorderData?.recommended_order_qty > 0
                    ? `Execute Purchase Order (${reorderData.recommended_order_qty} u)`
                    : 'Reorder Not Required'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
