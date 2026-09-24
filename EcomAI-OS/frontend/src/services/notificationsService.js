// Notifications service.

import { getDB, latency } from './mock/db';

export async function getNotifications(user) {
  await latency(300);
  const db = getDB(user);
  return db.notifications;
}

export async function getUnreadCount(user) {
  const db = getDB(user);
  return db.unreadCount();
}

export async function markNotificationRead(user, id) {
  await latency(150);
  const db = getDB(user);
  db.markNotificationRead(id);
  return db.notifications;
}

export async function markAllNotificationsRead(user) {
  await latency(200);
  const db = getDB(user);
  db.markAllNotificationsRead();
  return db.notifications;
}