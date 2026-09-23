import React from 'react';
import {
  LayoutDashboard,
  Boxes,
  TrendingUp,
  FlaskConical,
  Search,
  Settings,
} from 'lucide-react';

export default function Sidebar({ activeTab, onTabChange, reorderCount = 0 }) {
  const navItems = [
    { id: 'dashboard', name: 'Dashboard', icon: LayoutDashboard },
    {
      id: 'inventory',
      name: 'Inventory',
      icon: Boxes,
      badge: reorderCount > 0 ? `${reorderCount} Reorder` : null,
      badgeColor: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
    },
    { id: 'forecast', name: 'Forecast', icon: TrendingUp },
    { id: 'simulation', name: 'Simulation', icon: FlaskConical },
    { id: 'products', name: 'Products', icon: Search },
    { id: 'settings', name: 'Settings', icon: Settings },
  ];

  return (
    <aside className="w-56 border-r border-slate-800 bg-slate-950/80 p-3 flex flex-col justify-between shrink-0">
      <div className="space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-left transition-all ${
                isActive
                  ? 'bg-emerald-500/15 text-emerald-400 font-bold border border-emerald-500/30 shadow-sm'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-slate-900'
              }`}
            >
              <div className="flex items-center gap-3">
                <Icon className={`w-4 h-4 ${isActive ? 'text-emerald-400' : 'text-slate-400'}`} />
                <span className="text-sm">{item.name}</span>
              </div>
              {item.badge && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border ${item.badgeColor}`}>
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Subtle Bottom Status */}
      <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-[11px] text-slate-400">
        <div className="flex items-center justify-between">
          <span>AI Engine</span>
          <span className="text-emerald-400 font-semibold">Active</span>
        </div>
        <p className="mt-1 text-slate-400">Policy: Auto-Replenish v2</p>
      </div>
    </aside>
  );
}
