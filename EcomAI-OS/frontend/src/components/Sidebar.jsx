import React from 'react';
import {
  LayoutDashboard,
  TrendingUp,
  Boxes,
  Cpu,
  ShieldAlert,
  ArrowRight,
} from 'lucide-react';

export default function Sidebar({ activeTab, onTabChange, highRiskCount = 0 }) {
  const tabs = [
    {
      id: 'overview',
      name: 'Executive Overview',
      icon: LayoutDashboard,
      description: 'KPIs, portfolio valuation & risk',
    },
    {
      id: 'forecast',
      name: 'Demand Forecast & Lab',
      icon: TrendingUp,
      description: 'Recursive ML & What-If scenarios',
    },
    {
      id: 'inventory',
      name: 'Inventory & Reorders',
      icon: Boxes,
      badge: highRiskCount > 0 ? `${highRiskCount} Risk` : null,
      badgeColor: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
      description: 'ROP, safety stock, replenishment',
    },
    {
      id: 'backtest',
      name: 'Digital Twin Backtest',
      icon: Cpu,
      description: 'Policy simulation & Financial ROI',
    },
  ];

  return (
    <aside className="w-64 border-r border-slate-800 bg-slate-950/70 p-4 flex flex-col justify-between shrink-0">
      <div className="space-y-6">
        <div>
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 px-3">
            Core Modules
          </span>
          <nav className="mt-2 space-y-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => onTabChange(tab.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left transition-all ${
                    isActive
                      ? 'bg-emerald-500/15 text-emerald-400 font-semibold shadow-sm border border-emerald-500/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Icon className={`w-4 h-4 ${isActive ? 'text-emerald-400' : 'text-slate-400'}`} />
                    <span className="text-sm">{tab.name}</span>
                  </div>
                  {tab.badge && (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold border ${tab.badgeColor}`}
                    >
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* System Details Box */}
        <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 text-xs space-y-2">
          <div className="flex items-center justify-between text-slate-300 font-semibold">
            <span>Model Engine</span>
            <span className="text-emerald-400 font-mono">XGBoost 3.4</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Recursive multi-lag regression with 14 rolling demand, calendar, and promotional features.
          </p>
        </div>
      </div>

      <div className="p-3 rounded-xl bg-gradient-to-b from-slate-900 to-slate-900/40 border border-slate-800/80 text-[11px] text-slate-400">
        <div className="flex items-center gap-2 text-slate-300 font-medium mb-1">
          <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
          <span>Active Guardrails</span>
        </div>
        <span>Service Level Target: 99.0%</span>
        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-2">
          <div className="bg-emerald-500 h-full w-[99.4%] rounded-full"></div>
        </div>
      </div>
    </aside>
  );
}
