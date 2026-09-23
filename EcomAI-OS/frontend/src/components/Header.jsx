import React, { useState } from 'react';
import { Bell, User, CheckCircle2, AlertTriangle, AlertCircle, X } from 'lucide-react';

export default function Header({
  alerts = [],
  onSelectProduct,
  onNavigateTab,
}) {
  const [showNotifications, setShowNotifications] = useState(false);

  return (
    <header className="h-16 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md sticky top-0 z-40 px-6 flex items-center justify-between">
      {/* Brand */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="font-extrabold text-xl tracking-tight text-white">
            EcomAI<span className="text-emerald-400">-OS</span>
          </span>
          <span className="text-xs text-slate-400 font-medium hidden sm:inline border-l border-slate-700 pl-3">
            Inventory & Demand Intelligence
          </span>
        </div>
      </div>

      {/* Right Actions: Notifications 🔔 and User 👤 */}
      <div className="flex items-center gap-4">
        {/* Notification Bell */}
        <div className="relative">
          <button
            onClick={() => setShowNotifications(!showNotifications)}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors relative"
            title="Inventory Alerts"
          >
            <Bell className="w-5 h-5" />
            {alerts.length > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center border-2 border-slate-900 animate-pulse">
                {alerts.length}
              </span>
            )}
          </button>

          {/* Notifications Dropdown Drawer */}
          {showNotifications && (
            <div className="absolute right-0 mt-3 w-80 sm:w-96 rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-4 z-50 animate-fadeIn">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  <span className="text-sm font-bold text-white">Inventory Alerts ({alerts.length})</span>
                </div>
                <button
                  onClick={() => setShowNotifications(false)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="mt-3 max-h-72 overflow-y-auto space-y-2">
                {alerts.length === 0 ? (
                  <div className="py-6 text-center text-xs text-slate-400">
                    <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto mb-1" />
                    All inventory levels are optimal. No alerts.
                  </div>
                ) : (
                  alerts.map((a, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-white">{a.product_id} - {a.product_name}</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                            a.severity === 'high'
                              ? 'bg-rose-500/20 text-rose-300'
                              : 'bg-amber-500/20 text-amber-300'
                          }`}
                        >
                          {a.condition}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">{a.message}</p>
                      {a.recommended_reorder_qty > 0 && (
                        <div className="mt-2 flex justify-end">
                          <button
                            onClick={() => {
                              onSelectProduct(a.product_id);
                              onNavigateTab('inventory');
                              setShowNotifications(false);
                            }}
                            className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-[11px] transition-colors"
                          >
                            Review Reorder ({a.recommended_reorder_qty} u)
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* User Profile */}
        <div className="flex items-center gap-2 pl-3 border-l border-slate-800">
          <div className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 font-bold text-sm">
            <User className="w-4 h-4" />
          </div>
          <div className="hidden md:block text-left">
            <div className="text-xs font-bold text-white">Operations Lead</div>
            <div className="text-[10px] text-emerald-400 font-mono">Enterprise Plan</div>
          </div>
        </div>
      </div>
    </header>
  );
}
