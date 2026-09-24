// Settings service — account, inventory defaults, notification prefs, security.

import { getDB, latency, randomError } from './mock/db';

export async function getSettings(user) {
  await latency(300);
  const db = getDB(user);
  return { ...db.settings, user: { ...db.user } };
}

export async function updateSettings(user, patch) {
  await latency(450);
  const db = getDB(user);
  const allowed = ['currency', 'defaultLeadTime', 'safetyStockMethod', 'fixedSafetyDays', 'notifications'];
  for (const key of allowed) {
    if (patch[key] !== undefined) db.settings[key] = patch[key];
  }
  db.pushActivity('settings_updated', 'Updated store settings.');
  return { ...db.settings };
}

export async function updateNotificationPrefs(user, prefs) {
  await latency(300);
  const db = getDB(user);
  db.settings.notifications = { ...db.settings.notifications, ...prefs };
  return { ...db.settings.notifications };
}

export async function placeSimulatedOrder(user, productId, qty) {
  await latency(600);
  const db = getDB(user);
  const p = db.products.find((x) => x.id === productId);
  if (!p) throw randomError('This product could not be found.');
  db.updateProduct(productId, {
    openOrderQty: p.openOrderQty + Number(qty),
  });
  db.pushActivity('inventory_updated', `Placed purchase order for ${qty} units of ${p.name}.`);
  db.pushNotification({
    title: `Purchase order placed for ${p.name}.`,
    message: `${qty} units ordered. Expected arrival in ${p.leadTimeDays} days.`,
    severity: 'info',
  });
  return { ok: true, openOrderQty: p.openOrderQty + Number(qty) };
}