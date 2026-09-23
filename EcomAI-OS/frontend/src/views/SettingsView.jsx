import React, { useState } from 'react';
import { Settings, Save, ShieldCheck, IndianRupee, Clock, CheckCircle2 } from 'lucide-react';

export default function SettingsView({ onSaveSettings }) {
  const [serviceLevel, setServiceLevel] = useState('95');
  const [defaultLeadTime, setDefaultLeadTime] = useState('4');
  const [holdingRate, setHoldingRate] = useState('20');
  const [orderingCost, setOrderingCost] = useState('500');
  const [stockoutCost, setStockoutCost] = useState('1000');
  const [saved, setSaved] = useState(false);

  const handleSave = (e) => {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
    if (onSaveSettings) {
      onSaveSettings({
        serviceLevel,
        defaultLeadTime,
        holdingRate,
        orderingCost,
        stockoutCost,
      });
    }
  };

  return (
    <div className="space-y-6 max-w-3xl animate-fadeIn">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Settings</h1>
        <p className="text-slate-400 text-sm mt-0.5">
          Configure business rules, service level guardrails, and supply chain cost parameters.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Policy & Service Level */}
        <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 shadow-sm space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b border-slate-800">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold text-white">Target Service Level & Safety Stock</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400 block mb-1.5 font-medium">
                Portfolio Target Service Level:
              </label>
              <select
                value={serviceLevel}
                onChange={(e) => setServiceLevel(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 text-xs text-white rounded-xl px-3 py-2.5 focus:outline-none focus:border-emerald-500 cursor-pointer"
              >
                <option value="90">90% — Lean Inventory (Aggressive)</option>
                <option value="95">95% — Balanced Standard (Current Policy)</option>
                <option value="98">98% — High Availability (Conservative)</option>
                <option value="99">99% — Zero-Tolerance Stockout Buffer</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1.5 font-medium">
                Default Supplier Lead Time (Days):
              </label>
              <input
                type="number"
                min="1"
                max="30"
                value={defaultLeadTime}
                onChange={(e) => setDefaultLeadTime(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 text-xs text-white rounded-xl px-3 py-2.5 focus:outline-none focus:border-emerald-500 font-mono"
              />
            </div>
          </div>
        </div>

        {/* Cost Economics */}
        <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 shadow-sm space-y-4">
          <div className="flex items-center gap-2 pb-2 border-b border-slate-800">
            <IndianRupee className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold text-white">Financial Supply Chain Cost Drivers</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-slate-400 block mb-1.5 font-medium">
                Annual Holding Cost Rate (%):
              </label>
              <input
                type="number"
                min="5"
                max="50"
                value={holdingRate}
                onChange={(e) => setHoldingRate(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 text-xs text-white rounded-xl px-3 py-2.5 focus:outline-none focus:border-emerald-500 font-mono"
              />
              <span className="text-[10px] text-slate-500 mt-1 block">Cost of capital & storage</span>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1.5 font-medium">
                Fixed Cost per PO (₹):
              </label>
              <input
                type="number"
                min="0"
                step="50"
                value={orderingCost}
                onChange={(e) => setOrderingCost(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 text-xs text-white rounded-xl px-3 py-2.5 focus:outline-none focus:border-emerald-500 font-mono"
              />
              <span className="text-[10px] text-slate-500 mt-1 block">Logistics & admin processing</span>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1.5 font-medium">
                Stockout Penalty per Unit (₹):
              </label>
              <input
                type="number"
                min="0"
                step="100"
                value={stockoutCost}
                onChange={(e) => setStockoutCost(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 text-xs text-white rounded-xl px-3 py-2.5 focus:outline-none focus:border-emerald-500 font-mono"
              />
              <span className="text-[10px] text-slate-500 mt-1 block">Lost margin & customer churn</span>
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className="flex items-center justify-between">
          {saved ? (
            <div className="flex items-center gap-2 text-xs font-bold text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              <span>Configuration saved successfully!</span>
            </div>
          ) : (
            <div></div>
          )}

          <button
            type="submit"
            className="py-2.5 px-6 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 transition-colors shadow-md"
          >
            <Save className="w-4 h-4" />
            <span>Save Configuration</span>
          </button>
        </div>
      </form>
    </div>
  );
}
