import React, { useState } from 'react';
import { Outlet, useLocation, NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Boxes,
  Package,
  TrendingUp,
  Settings,
} from 'lucide-react';
import { Sidebar, MobileDrawer } from './Sidebar';
import Header from './Header';
import { ConfirmDialog } from '../ui/Modal';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { cn } from '../../lib/utils';

const BOTTOM_TABS = [
  { to: '/app', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/app/inventory', label: 'Inventory', icon: Boxes },
  { to: '/app/products', label: 'Products', icon: Package },
  { to: '/app/forecast', label: 'Forecast', icon: TrendingUp },
  { to: '/app/settings', label: 'Settings', icon: Settings },
];

export default function AppShell() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      toast.info('You have been signed out.');
      // Navigation to /login happens via the route guard reacting to user==null
    } catch {
      toast.error('Unable to sign out. Please try again.');
      setLoggingOut(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Desktop sidebar */}
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        user={user}
        onLogout={() => setLogoutOpen(true)}
      />

      {/* Mobile drawer */}
      <MobileDrawer
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        user={user}
        onLogout={() => {
          setMobileOpen(false);
          setLogoutOpen(true);
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onMenuClick={() => setMobileOpen(true)} onLogout={() => setLogoutOpen(true)} />

        {/* Mobile search row */}
        <div className="border-b border-slate-200 bg-white px-4 py-2.5 md:hidden">
          <SearchRow />
        </div>

        <main className="flex-1 overflow-x-hidden">
          <div key={location.pathname} className="mx-auto max-w-7xl animate-fade-in px-4 py-6 sm:px-6 lg:px-8 lg:py-8 pb-24 lg:pb-8">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Mobile bottom navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around border-t border-slate-200 bg-white/95 backdrop-blur lg:hidden pb-[env(safe-area-inset-bottom)]">
        {BOTTOM_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-semibold',
                isActive ? 'text-brand-600' : 'text-slate-400',
              )
            }
          >
            <tab.icon className="h-5 w-5" />
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <ConfirmDialog
        open={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        onConfirm={handleLogout}
        title="Sign out of EcomAI-OS?"
        message="You will need to sign in again to access your workspace."
        confirmLabel="Sign out"
        loading={loggingOut}
      />
    </div>
  );
}

function SearchRow() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search products, SKUs…"
        className="input pl-8 text-sm"
      />
      <svg
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
      </svg>
      {q && (
        <button
          onMouseDown={() => {
            if (!user) return;
            window.location.href = `/app/inventory?q=${encodeURIComponent(q)}`;
          }}
          className="absolute inset-y-0 right-0 flex items-center rounded-r-lg border-l border-slate-200 bg-slate-50 px-3 text-xs font-semibold text-brand-600"
        >
          Go
        </button>
      )}
    </div>
  );
}