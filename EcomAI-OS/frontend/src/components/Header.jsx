import React from 'react';
import { Sparkles, Layers, Box, AlertTriangle, CheckCircle2, ChevronDown } from 'lucide-react';

export default function Header({
  products = [],
  selectedProductId,
  onSelectProduct,
  backendConnected = true,
  overviewData = null,
}) {
  const selectedProduct = products.find((p) => p.product_id === selectedProductId);

  return (
    <header className="h-16 border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-40 px-6 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 via-teal-500 to-cyan-400 p-[1px] shadow-lg shadow-emerald-500/20">
          <div className="w-full h-full bg-slate-950 rounded-[11px] flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-emerald-400" />
          </div>
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-lg tracking-tight text-white">EcomAI<span className="text-emerald-400">-OS</span></span>
            <span className="px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full">
              ML Engine v2.0
            </span>
          </div>
          <p className="text-xs text-slate-400 hidden sm:block">
            Autonomous Inventory & Demand Forecasting Operating System
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {/* Active Product Selector */}
        <div className="flex items-center gap-2 bg-slate-800/80 border border-slate-700/80 rounded-xl px-3 py-1.5 shadow-sm">
          <Box className="w-4 h-4 text-emerald-400" />
          <span className="text-xs text-slate-400 hidden md:inline">Focus SKU:</span>
          <select
            value={selectedProductId || ''}
            onChange={(e) => onSelectProduct(e.target.value)}
            className="bg-transparent text-sm font-semibold text-slate-100 focus:outline-none cursor-pointer pr-2"
          >
            {products.map((p) => (
              <option key={p.product_id} value={p.product_id} className="bg-slate-900 text-slate-200">
                {p.product_id} - {p.product_name} ({p.category})
              </option>
            ))}
          </select>
        </div>

        {/* Backend Status Indicator */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-900/80 border border-slate-800 rounded-xl text-xs">
          <span className="relative flex h-2 w-2">
            {backendConnected ? (
              <>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </>
            ) : (
              <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
            )}
          </span>
          <span className="text-slate-300 font-medium">
            {backendConnected ? 'FastAPI Online' : 'Connecting...'}
          </span>
        </div>
      </div>
    </header>
  );
}
