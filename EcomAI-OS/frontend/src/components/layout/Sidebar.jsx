import React, { useState, useRef, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Boxes,
  Package,
  Database,
  TrendingUp,
  Lightbulb,
  FlaskConical,
  Settings,
  LogOut,
  ChevronLeft,
  X,
  ChevronDown,
} from 'lucide-react';
import { Logo } from './Logo';
import { Avatar } from './Logo';
import { cn } from '../../lib/utils';

export const NAV_SECTIONS = [
  {
    label: 'Main',
    items: [
      { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/app/inventory', label: 'Inventory', icon: Boxes },
      { to: '/app/products', label: 'Products', icon: Package },
      { to: '/app/sales', label: 'Sales Data', icon: Database },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { to: '/app/forecast', label: 'Forecast', icon: TrendingUp },
      { to: '/app/recommendations', label: 'Recommendations', icon: Lightbulb },
      { to: '/app/simulation', label: 'Simulation', icon: FlaskConical },
    ],
  },
  {
    label: 'System',
    items: [{ to: '/app/settings', label: 'Settings', icon: Settings }],
  },
];

function NavItems({ collapsed }) {
  return (
    <nav className="space-y-5">
      {NAV_SECTIONS.map((section) => (
        <div key={section.label}>
          {!collapsed && (
            <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              {section.label}
            </p>
          )}
          <div className="space-y-0.5">
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                title={item.label}
                className={({ isActive }) =>
                  cn(
                    'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
                    collapsed && 'justify-center px-2',
                    isActive
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                  )
                }
              >
                <item.icon
                  className={cn(
                    'h-[18px] w-[18px] shrink-0',
                    collapsed && 'h-5 w-5',
                  )}
                />
                {!collapsed && <span className="truncate">{item.label}</span>}
                {!collapsed && false}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

export function Sidebar({ collapsed, onToggleCollapse, user, onLogout }) {
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef(null);

  useEffect(() => {
    if (!profileOpen) return undefined;
    const handler = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [profileOpen]);

  return (
    <aside
      className={cn(
        'hidden lg:flex flex-col border-r border-slate-200 bg-white transition-[width] duration-200 ease-in-out',
        collapsed ? 'w-[72px]' : 'w-64',
      )}
    >
      <div className={cn('flex h-16 items-center border-b border-slate-100', collapsed ? 'justify-center px-2' : 'px-5')}>
        <Logo />
        {!collapsed && (
          <span className="ml-2.5 text-[17px] font-extrabold tracking-tight text-slate-900">
            EcomAI<span className="text-brand-600">-OS</span>
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-5">
        <NavItems collapsed={collapsed} />
      </div>

      <button
        onClick={onToggleCollapse}
        className={cn(
          'mx-3 mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-slate-400 hover:bg-slate-100 hover:text-slate-600',
          collapsed && 'justify-center px-0',
        )}
      >
        <ChevronLeft className={cn('h-4 w-4 transition-transform', collapsed && 'rotate-180')} />
        {!collapsed && <span>Collapse sidebar</span>}
      </button>

      {/* User card */}
      <div ref={profileRef} className="relative border-t border-slate-100 p-3">
        <button
          onClick={() => setProfileOpen((o) => !o)}
          className={cn(
            'flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-slate-50',
            collapsed && 'justify-center px-0',
          )}
        >
          <Avatar name={user?.name} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-800">{user?.name}</span>
                <span className="block truncate text-[11px] text-slate-400">{user?.email}</span>
              </span>
              <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', profileOpen && 'rotate-180')} />
            </>
          )}
        </button>

        {profileOpen && !collapsed && (
          <div className="absolute bottom-full left-3 right-3 z-20 mb-1 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-pop animate-slide-up">
            <NavLink
              to="/app/settings"
              onClick={() => setProfileOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              <Settings className="h-4 w-4" /> My Profile
            </NavLink>
            <button
              onClick={() => {
                setProfileOpen(false);
                onLogout();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-rose-600 hover:bg-rose-50"
            >
              <LogOut className="h-4 w-4" /> Logout
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

export function MobileDrawer({ open, onClose, user, onLogout }) {
  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden animate-fade-in" onClick={onClose} aria-hidden />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-72 -translate-x-full flex-col border-r border-slate-200 bg-white transition-transform duration-200 lg:hidden',
          open && 'translate-x-0',
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-slate-100 px-5">
          <span className="flex items-center gap-2.5">
            <Logo />
            <span className="text-[17px] font-extrabold tracking-tight text-slate-900">
              EcomAI<span className="text-brand-600">-OS</span>
            </span>
          </span>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-5">
          <NavItems collapsed={false} />
          <div className="mt-6 border-t border-slate-100 pt-4">
            <button
              onClick={onLogout}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50"
            >
              <LogOut className="h-4 w-4" /> Logout
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-slate-100 p-4">
          <Avatar name={user?.name} size="sm" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-800">{user?.name}</p>
            <p className="truncate text-[11px] text-slate-400">{user?.email}</p>
          </div>
        </div>
      </aside>
    </>
  );
}