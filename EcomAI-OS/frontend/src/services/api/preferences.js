// Notification bell, activity source and store preferences.
//
// Two things here have no server-side home, and both are stated rather than
// disguised:
//
//   * Notifications are *derived* from the tenant's own audit trail. There is no
//     notifications table, so nothing is invented: the bell shows the audit
//     actions that represent a business event a merchant would want to know
//     about, and nothing else. The row-level bookkeeping actions
//     (`sales_upserted`, `product_upserted`) fire once per committed row, so
//     they belong in the activity feed, not a bell that would otherwise carry
//     thousands of entries. See :data:`NOTIFIABLE_ACTIONS`.
//
//   * Read/unread state and display preferences are browser-local, keyed by the
//     signed-in tenant. They are UI state about this browser, not business data,
//     so they are kept in localStorage rather than presented as server records.

import * as http from './http';
import { toActivity } from './adapters';
import { tenantId } from './mode';

const READ_KEY = 'ecomai.readNotifications.v1';
const SETTINGS_KEY = 'ecomai.preferences.v1';

/** Audit actions worth interrupting someone about. */
const NOTIFIABLE_ACTIONS = new Set([
  'product_deleted',
  'forecast_ml_failed',
  'simulation_backtested',
  'forecast_generated',
]);

const NOTIFICATION_SEVERITY = {
  product_deleted: 'warning',
  forecast_ml_failed: 'warning',
  simulation_backtested: 'success',
  forecast_generated: 'success',
};

const DEFAULT_SETTINGS = {
  currency: 'INR',
  defaultLeadTime: 7,
  safetyStockMethod: 'statistical',
  fixedSafetyDays: 7,
  notifications: {
    lowStock: true,
    stockout: true,
    forecast: true,
    simulation: true,
  },
};

const NOTIFICATION_LIMIT = 30;

function readJSON(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A browser with storage disabled still gets a working session; the
    // preference simply does not survive a reload.
  }
}

function readState(user) {
  const all = readJSON(READ_KEY, {});
  return all[tenantId(user)] || {};
}

function writeState(user, state) {
  const all = readJSON(READ_KEY, {});
  all[tenantId(user)] = state;
  writeJSON(READ_KEY, all);
}

async function loadAudit(user) {
  const audit = await http.fetchAudit(user);
  return audit.audit || [];
}

function toNotifications(entries, readStateMap) {
  return entries
    .filter((entry) => NOTIFIABLE_ACTIONS.has(entry.action))
    .slice(0, NOTIFICATION_LIMIT)
    .map((entry) => ({
      id: String(entry.id),
      title: toActivity(entry).title,
      message: toActivity(entry).description,
      severity: NOTIFICATION_SEVERITY[entry.action] || 'info',
      time: entry.created_at,
      read: Boolean(readStateMap[entry.id]),
      action: entry.action,
      productId: entry.product_id || null,
    }));
}

export async function getNotifications(user) {
  const entries = await loadAudit(user);
  return toNotifications(entries, readState(user));
}

export async function getUnreadCount(user) {
  const entries = await loadAudit(user);
  const state = readState(user);
  return toNotifications(entries, state).filter((n) => !n.read).length;
}

export async function markNotificationRead(user, id) {
  const entries = await loadAudit(user);
  const state = { ...readState(user), [id]: true };
  writeState(user, state);
  return toNotifications(entries, state);
}

export async function markAllNotificationsRead(user) {
  const entries = await loadAudit(user);
  const state = {};
  entries.forEach((entry) => {
    if (NOTIFIABLE_ACTIONS.has(entry.action)) state[entry.id] = true;
  });
  writeState(user, state);
  return toNotifications(entries, state);
}

/** The whole audit trail, oldest first, as the activity feed reads it. */
export async function getActivity(user, { limit = 20 } = {}) {
  const entries = await loadAudit(user);
  return entries
    .slice(0, limit)
    .map(toActivity)
    .sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

// ---------------------------------------------------------------- preferences

function readSettings(user) {
  const all = readJSON(SETTINGS_KEY, {});
  return { ...DEFAULT_SETTINGS, ...(all[tenantId(user)] || {}) };
}

function writeSettings(user, settings) {
  const all = readJSON(SETTINGS_KEY, {});
  all[tenantId(user)] = settings;
  writeJSON(SETTINGS_KEY, all);
}

export async function getSettings(user) {
  return { ...readSettings(user), user: { ...user } };
}

export async function updateSettings(user, patch) {
  const current = readSettings(user);
  const next = { ...current };
  const allowed = ['currency', 'defaultLeadTime', 'safetyStockMethod', 'fixedSafetyDays'];
  for (const key of allowed) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.notifications !== undefined) {
    next.notifications = { ...current.notifications, ...patch.notifications };
  }
  writeSettings(user, next);
  return { ...next };
}

export async function updateNotificationPrefs(user, prefs) {
  const current = readSettings(user);
  const next = {
    ...current,
    notifications: { ...current.notifications, ...prefs },
  };
  writeSettings(user, next);
  return { ...next.notifications };
}

export { DEFAULT_SETTINGS };
