// Mock authentication service.
// Users are persisted in localStorage so multi-user behaviour survives reloads.
// Swap this module for a real auth API without touching the UI.

import { getDB, latency, randomError } from './mock/db';
import { hashString } from '../lib/utils';

const USERS_KEY = 'ecomai.users.v1';
const SESSION_KEY = 'ecomai.session.v1';

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function maskPassword(password) {
  // Trivial hash — for demo purposes only. A real backend owns credential security.
  return String(hashString('ecomai:' + password)());
}

function getAllUsers() {
  const users = readJSON(USERS_KEY, {});
  if (!users.u_demo) {
    users.u_demo = {
      id: 'u_demo',
      name: 'Aarav Mehta',
      email: 'demo@ecomai.app',
      businessName: 'TerraMart Retail',
      password: maskPassword('demo1234'),
      createdAt: Date.now() - 90 * 86400000,
    };
    writeJSON(USERS_KEY, users);
  }
  return users;
}

export const DEMO_CREDENTIALS = { email: 'demo@ecomai.app', password: 'demo1234' };

export async function login({ email, password }) {
  await latency(600);
  const users = getAllUsers();
  const record = Object.values(users).find(
    (u) => u.email.toLowerCase() === String(email || '').trim().toLowerCase(),
  );
  if (!record) throw randomError('No account found with this email address.');
  if (record.password !== maskPassword(password)) {
    throw randomError('Incorrect password. Please try again.');
  }
  const token = String(hashString(`${record.id}:${Date.now()}`)());
  writeJSON(SESSION_KEY, { userId: record.id, token });
  const { password: _pw, resetToken: _rt, resetTokenExpiry: _re, ...safe } = record;
  const user = { ...safe, flags: { freshSignup: false } };
  return { user, token };
}

export async function signup({ fullName, businessName, email, password }) {
  await latency(800);
  const users = getAllUsers();
  const exists = Object.values(users).some(
    (u) => u.email.toLowerCase() === String(email || '').trim().toLowerCase(),
  );
  if (exists) throw randomError('An account with this email already exists.');
  const id = `u_${String(hashString(email + Date.now())()).toString(36)}`;
  const record = {
    id,
    name: fullName?.trim() || 'New User',
    email: email?.trim().toLowerCase(),
    businessName: businessName?.trim() || 'My Store',
    password: maskPassword(password),
    createdAt: Date.now(),
  };
  users[id] = record;
  writeJSON(USERS_KEY, users);
  const token = String(hashString(`${id}:signed:${Date.now()}`)());
  writeJSON(SESSION_KEY, { userId: id, token });
  const { password: _pw, ...safe } = record;
  return { user: { ...safe, flags: { freshSignup: true } }, token };
}

export async function getSession() {
  const session = readJSON(SESSION_KEY, null);
  if (!session?.userId) return null;
  const users = getAllUsers();
  const record = users[session.userId];
  if (!record) {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
  const { password: _pw, resetToken: _rt, resetTokenExpiry: _re, ...safe } = record;
  return { user: { ...safe }, token: session.token };
}

export async function logout() {
  localStorage.removeItem(SESSION_KEY);
}

export async function requestPasswordReset(email) {
  await latency(700);
  const users = getAllUsers();
  const record = Object.values(users).find(
    (u) => u.email.toLowerCase() === String(email || '').trim().toLowerCase(),
  );
  if (!record) {
    // Never reveal account existence.
    return { ok: true, sent: false };
  }
  const token = String(hashString(`${record.id}:reset:${Date.now()}`)());
  record.resetToken = token;
  record.resetTokenExpiry = Date.now() + 15 * 60000;
  writeJSON(USERS_KEY, users);
  // Simulate a delivered email for the demo:
  return { ok: true, sent: true, resetToken: token, email: record.email };
}

export async function resetPassword({ token, password }) {
  await latency(700);
  const users = getAllUsers();
  const record = Object.values(users).find((u) => u.resetToken === token);
  if (!record) throw randomError('This reset link is invalid or has already been used.');
  if (record.resetTokenExpiry < Date.now()) {
    throw randomError('This reset link has expired. Please request a new one.');
  }
  record.password = maskPassword(password);
  delete record.resetToken;
  delete record.resetTokenExpiry;
  writeJSON(USERS_KEY, users);
  return { ok: true };
}

export async function updateProfile(user, patch) {
  await latency(500);
  const users = getAllUsers();
  const record = users[user.id];
  if (!record) throw randomError('Account not found.');
  Object.assign(record, {
    name: patch.name ?? record.name,
    businessName: patch.businessName ?? record.businessName,
    email: patch.email ?? record.email,
  });
  writeJSON(USERS_KEY, users);
  const db = getDB(record);
  db.user = { ...record };
  return { ...record };
}

export async function changePassword(user, { currentPassword, newPassword }) {
  await latency(600);
  const users = getAllUsers();
  const record = users[user.id];
  if (!record) throw randomError('Account not found.');
  if (record.password !== maskPassword(currentPassword)) {
    throw randomError('Your current password is incorrect.');
  }
  record.password = maskPassword(newPassword);
  writeJSON(USERS_KEY, users);
  return { ok: true };
}

export async function logoutAllSessions() {
  await latency(500);
  // In the mock there is one session; a real backend would revoke refresh tokens.
  return { ok: true };
}

export async function deleteAccount(user, password) {
  const users = getAllUsers();
  const record = users[user.id];
  if (!record || record.password !== maskPassword(password)) {
    throw randomError('Password is incorrect.');
  }
  delete users[user.id];
  writeJSON(USERS_KEY, users);
  localStorage.removeItem(SESSION_KEY);
  return { ok: true };
}

export { getDB };