import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import {
  Bell,
  Search,
  Settings,
  User,
  LogOut,
  CheckCheck,
  Menu,
  PackageSearch,
  Info,
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
} from 'lucide-react';
import { NAV_SECTIONS } from './Sidebar';
import { Avatar } from './Logo';
import { useAuth } from '../../context/AuthContext';
import { useData } from '../../context/DataContext';
import { listProducts } from '../../services/inventoryService';
import { cn, timeAgo } from '../../lib/utils';

const TITLES = Object.fromEntries(
  NAV_SECTIONS.flatMap((s) => s.items).map((i) => [i.to, i.label]),
);

const NOTIF_ICONS = {
  info: { icon: Info, cls: 'bg-brand-50 text-brand-600' },
  success: { icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-600' },
  warning: { icon: AlertTriangle, cls: 'bg-amber-50 text-amber-600' },
  critical: { icon: AlertOctagon, cls: 'bg-rose-50 text-rose-600' },
};

export default function Header({ onMenuClick, onLogout }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { notifications, unread, markAllRead } = useData();

  const title = useMemo(() => {
    if (location.pathname.startsWith('/app/products/')) return 'Product Details';
    return TITLES[location.pathname] || 'Dashboard';
  }, [location.pathname]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef(null);
  const searchTimer = useRef(null);

  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const notifRef = useRef(null);
  const profileRef = useRef(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSearching(false);
      setSearchOpen(false);
      return undefined;
    }
    setSearching(true);
    setSearchOpen(true);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        if (!user) return;
        const res = await listProducts(user, { search: query.trim(), pageSize: 8 });
        setResults(res.items);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(searchTimer.current);
  }, [query, user]);

  useEffect(() => {
    const handler = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false);
      if (profileRef.current && !profileRef.current.contains(e.target)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectProduct = (id) => {
    setQuery('');
    setSearchOpen(false);
    navigate(`/app/products/${id}`);
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur-md sm:px-6">
      <button
        onClick={onMenuClick}
        className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      <h1 className="text-base font-bold tracking-tight text-slate-900 sm:text-lg">{title}</h1>

      {/* Global search */}
      <div ref={searchRef} className="relative ml-auto hidden w-full max-w-md md:block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => query && setSearchOpen(true)}
          placeholder="Search products, SKUs…"
          className="input pl-9"
        />
        {searchOpen && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-pop animate-slide-up">
            {searching ? (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-slate-400">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
                Searching…
              </div>
            ) : results.length ? (
              <ul className="max-h-80 overflow-y-auto py-1">
                {results.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => selectProduct(p.id)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50"
                    >
                      <PackageSearch className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-700">{p.name}</span>
                        <span className="block text-[11px] text-slate-400">
                          {p.id} · {p.category}
                        </span>
                      </span>
                      <StockPill status={p.status} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-xs text-slate-400">No products match “{query}”.</p>
            )}
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1.5 md:ml-0">
        {/* Notifications */}
        <div ref={notifRef} className="relative">
          <button
            onClick={() => setNotifOpen((o) => !o)}
            className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100"
            aria-label="Notifications"
          >
            <Bell className="h-5 w-5" />
            {unread > 0 && (
              <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>

          {notifOpen && (
            <div className="absolute right-0 top-full z-30 mt-1.5 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-pop animate-slide-up sm:w-96">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <p className="text-sm font-bold text-slate-800">Notifications</p>
                {unread > 0 && (
                  <button
                    onClick={markAllRead}
                    className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700"
                  >
                    <CheckCheck className="h-3.5 w-3.5" /> Mark all read
                  </button>
                )}
              </div>
              {notifications.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-slate-400">You’re all caught up.</p>
              ) : (
                <ul className="max-h-96 overflow-y-auto">
                  {notifications.map((n) => {
                    const cfg = NOTIF_ICONS[n.severity] || NOTIF_ICONS.info;
                    const Icon = cfg.icon;
                    return (
                      <li
                        key={n.id}
                        className={cn('flex gap-3 border-b border-slate-50 px-4 py-3', !n.read && 'bg-brand-50/40')}
                      >
                        <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', cfg.cls)}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-800">{n.title}</p>
                          {n.message && <p className="mt-0.5 text-xs text-slate-500">{n.message}</p>}
                          <p className="mt-1 text-[10px] font-medium text-slate-400">{timeAgo(n.time)}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Profile */}
        <div ref={profileRef} className="relative">
          <button
            onClick={() => setProfileOpen((o) => !o)}
            className="flex items-center gap-2 rounded-lg p-1.5 pr-2 hover:bg-slate-100"
          >
            <Avatar name={user?.name} size="sm" />
            <span className="hidden text-sm font-semibold text-slate-700 sm:block">{user?.name?.split(' ')[0]}</span>
          </button>
          {profileOpen && (
            <div className="absolute right-0 top-full z-30 mt-1.5 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-pop animate-slide-up">
              <div className="border-b border-slate-100 px-4 py-2.5">
                <p className="truncate text-sm font-semibold text-slate-800">{user?.name}</p>
                <p className="truncate text-xs text-slate-400">{user?.email}</p>
              </div>
              <Link
                to="/app/settings"
                onClick={() => setProfileOpen(false)}
                className="flex items-center gap-2 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                <User className="h-4 w-4" /> My Profile
              </Link>
              <Link
                to="/app/settings"
                onClick={() => setProfileOpen(false)}
                className="flex items-center gap-2 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                <Settings className="h-4 w-4" /> Settings
              </Link>
              <button
                onClick={() => {
                  setProfileOpen(false);
                  setNotifOpen(true);
                }}
                className="flex w-full items-center gap-2 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                <Bell className="h-4 w-4" /> Notifications
              </button>
              <button
                onClick={() => {
                  setProfileOpen(false);
                  onLogout();
                }}
                className="flex w-full items-center gap-2 px-4 py-2 text-sm text-rose-600 hover:bg-rose-50"
              >
                <LogOut className="h-4 w-4" /> Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function StockPill({ status }) {
  const map = {
    healthy: 'text-emerald-700 bg-emerald-50',
    low: 'text-amber-700 bg-amber-50',
    critical: 'text-rose-700 bg-rose-50',
    overstocked: 'text-sky-700 bg-sky-50',
  };
  const label = { healthy: 'Healthy', low: 'Low Stock', critical: 'Critical', overstocked: 'Overstocked' };
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', map[status])}>{label[status]}</span>
  );
}

export function MobileSearch() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div className="relative md:hidden">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search products…"
        className="input pl-9"
      />
      {open && query && (
        <div className="absolute inset-x-0 top-full z-30 mt-1.5 rounded-xl border border-slate-200 bg-white p-2 shadow-pop">
          <button
            onClick={() => {
              navigate(`/app/inventory?q=${encodeURIComponent(query)}`);
              setOpen(false);
              setQuery('');
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            <PackageSearch className="h-4 w-4 text-slate-400" />
            Search inventory for “{query}”
          </button>
        </div>
      )}
    </div>
  );
}