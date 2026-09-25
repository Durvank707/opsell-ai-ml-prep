// Authentication service.
//
// The default remains the deterministic local mock so the UI is immediately
// runnable. Set VITE_AUTH_MODE=external when an identity provider owns real
// credentials; this module then stores only the provider's access token in
// sessionStorage and never treats the mock password hash as a JWT.

import { getDB, latency, randomError } from './mock/db';
import { hashString } from '../lib/utils';
import {
  clearAccessToken,
  getAccessToken,
  setAccessToken,
} from '../api/tokenStore';

const USERS_KEY = 'ecomai.users.v1';
const SESSION_KEY = 'ecomai.session.v1';
const AUTH_MODE = String(import.meta.env.VITE_AUTH_MODE || 'mock').toLowerCase();
const REMOTE_AUTH = AUTH_MODE === 'external' || AUTH_MODE === 'remote';
const BACKEND_AUTH = AUTH_MODE === 'backend' || AUTH_MODE === 'local';

function provider() {
  if (typeof window === 'undefined') return null;
  return window.__ECOMAI_OS_AUTH__ || null;
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function remoteUserFromResponse(payload, token) {
  const claims = decodeJwtPayload(token) || {};
  const source = payload?.user || payload?.profile || {};
  const id = source.id || source.sub || claims.sub || claims.user_id;
  if (!id || typeof id !== 'string') {
    throw new Error('The identity provider returned no user identity.');
  }
  return {
    id,
    sub: id,
    email: source.email || claims.email || '',
    name: source.name || source.full_name || claims.name || id,
    businessName: source.businessName || source.business_name || '',
    flags: { freshSignup: Boolean(source.flags?.freshSignup) },
  };
}

async function providerRequest(path, payload) {
  const base = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
  if (!path || !base) throw new Error('No external authentication endpoint is configured.');
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.detail || body.message || 'The identity provider rejected the request.');
  }
  const token = body.access_token || body.accessToken || body.token;
  if (!token || typeof token !== 'string') {
    throw new Error('The identity provider returned no access token.');
  }
  setAccessToken(token);
  return { user: remoteUserFromResponse(body, token), token };
}

async function backendRequest(path, { method = 'GET', payload, auth = false } = {}) {
  const base = String(import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
  const token = getAccessToken();
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    if (!token) throw new Error('Authentication is required.');
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${base}/auth${path}`, {
    method,
    headers,
    body: payload == null ? undefined : JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) clearAccessToken();
    throw new Error(body.detail || body.message || 'Authentication request failed.');
  }
  return body;
}

function requireProvider(method) {
  const adapter = provider()?.[method];
  if (typeof adapter !== 'function') {
    throw new Error(
      'This account action is managed by the external identity provider.',
    );
  }
  return adapter;
}

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

export { AUTH_MODE };
export const DEMO_CREDENTIALS = { email: 'demo@ecomai.app', password: 'demo1234' };

export async function login({ email, password }) {
  if (BACKEND_AUTH) {
    const result = await backendRequest('/login', {
      method: 'POST',
      payload: { email, password },
    });
    const token = result.access_token || result.token;
    if (!token) throw new Error('The backend returned no access token.');
    setAccessToken(token);
    return { user: result.user, token };
  }
  if (REMOTE_AUTH) {
    const hook = provider()?.login;
    if (typeof hook === 'function') {
      const result = await hook({ email, password });
      const token = result?.token || result?.access_token;
      if (!token) throw new Error('The identity provider returned no access token.');
      setAccessToken(token);
      return { user: remoteUserFromResponse(result, token), token };
    }
    return providerRequest(import.meta.env.VITE_AUTH_LOGIN_URL || '/auth/login', {
      email,
      password,
    });
  }
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
  if (BACKEND_AUTH) {
    const result = await backendRequest('/signup', {
      method: 'POST',
      payload: { fullName, businessName, email, password },
    });
    const token = result.access_token || result.token;
    if (!token) throw new Error('The backend returned no access token.');
    setAccessToken(token);
    return { user: result.user, token };
  }
  if (REMOTE_AUTH) {
    const hook = provider()?.signup;
    if (typeof hook === 'function') {
      const result = await hook({ fullName, businessName, email, password });
      const token = result?.token || result?.access_token;
      if (!token) throw new Error('The identity provider returned no access token.');
      setAccessToken(token);
      return { user: remoteUserFromResponse(result, token), token };
    }
    return providerRequest(import.meta.env.VITE_AUTH_SIGNUP_URL || '/auth/signup', {
      full_name: fullName,
      business_name: businessName,
      email,
      password,
    });
  }
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
  if (BACKEND_AUTH) {
    if (!getAccessToken()) return null;
    try {
      const result = await backendRequest('/me', { auth: true });
      return { user: result.user, token: getAccessToken() };
    } catch {
      clearAccessToken();
      return null;
    }
  }
  if (REMOTE_AUTH) {
    const token = getAccessToken();
    if (!token) return null;
    const claims = decodeJwtPayload(token);
    if (!claims || (claims.exp != null && Number(claims.exp) * 1000 <= Date.now())) {
      clearAccessToken();
      return null;
    }
    return { user: remoteUserFromResponse({}, token), token };
  }
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
  if (BACKEND_AUTH) {
    try {
      if (getAccessToken()) await backendRequest('/logout', { method: 'POST', auth: true });
    } finally {
      clearAccessToken();
    }
    return;
  }
  if (REMOTE_AUTH) {
    try {
      const hook = provider()?.logout;
      if (typeof hook === 'function') await hook();
    } finally {
      clearAccessToken();
    }
    return;
  }
  localStorage.removeItem(SESSION_KEY);
}

export async function requestPasswordReset(email) {
  if (BACKEND_AUTH) {
    throw new Error('Password reset is not enabled for the local backend issuer.');
  }
  if (REMOTE_AUTH) {
    const hook = provider()?.requestPasswordReset || provider()?.resetPassword;
    if (typeof hook !== 'function') {
      throw new Error('Password reset is managed by the external identity provider.');
    }
    return hook({ email });
  }
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
  if (BACKEND_AUTH) {
    throw new Error('Password reset is not enabled for the local backend issuer.');
  }
  if (REMOTE_AUTH) {
    const hook = requireProvider('resetPassword');
    return hook({ token, password });
  }
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
  if (BACKEND_AUTH) {
    throw new Error('Profile updates are not enabled for the local backend issuer.');
  }
  if (REMOTE_AUTH) {
    return requireProvider('updateProfile')({ user, patch });
  }
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
  if (BACKEND_AUTH) {
    throw new Error('Password changes are not enabled for the local backend issuer.');
  }
  if (REMOTE_AUTH) {
    return requireProvider('changePassword')({ user, currentPassword, newPassword });
  }
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
  if (BACKEND_AUTH) {
    return { ok: true };
  }
  if (REMOTE_AUTH) {
    const hook = provider()?.logoutAllSessions;
    if (typeof hook !== 'function') return { ok: true };
    return hook();
  }
  await latency(500);
  // In the mock there is one session; a real backend would revoke refresh tokens.
  return { ok: true };
}

export async function deleteAccount(user, password) {
  if (BACKEND_AUTH) {
    throw new Error('Account deletion is not enabled for the local backend issuer.');
  }
  if (REMOTE_AUTH) {
    return requireProvider('deleteAccount')({ user, password });
  }
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