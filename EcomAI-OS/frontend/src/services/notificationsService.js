// Notifications service.
//
// The bell is fed by the mock store in `mock` mode and by the tenant's own audit
// trail in `api` mode, with read state kept per browser. See `api/preferences.js`
// for what that derivation does and does not claim.

import { getDB, latency } from './mock/db';
import { usingApi } from './api/mode';
import * as api from './api/preferences';

export async function getNotifications(user) {
  if (usingApi()) return api.getNotifications(user);
  await latency(300);
  const db = getDB(user);
  return db.notifications;
}

export async function getUnreadCount(user) {
  if (usingApi()) return api.getUnreadCount(user);
  const db = getDB(user);
  return db.unreadCount();
}

export async function markNotificationRead(user, id) {
  if (usingApi()) return api.markNotificationRead(user, id);
  await latency(150);
  const db = getDB(user);
  db.markNotificationRead(id);
  return db.notifications;
}

export async function markAllNotificationsRead(user) {
  if (usingApi()) return api.markAllNotificationsRead(user);
  await latency(200);
  const db = getDB(user);
  db.markAllNotificationsRead();
  return db.notifications;
}
