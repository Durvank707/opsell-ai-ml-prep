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
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
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
    // Only a 401 that says the *bearer* was rejected ends the session. A 401
    // from a credential checked in the request body -- a wrong current password
    // -- is a message to show the user, not a reason to wipe their tokens. The
    // server keeps the two apart by status: 401 for the token, 403 for the
    // credential.
    if (response.status === 401 && response.headers.has('WWW-Authenticate')) {
      clearAccessToken();
    }
    throw new Error(body.detail || body.message || 'Authentication request failed.');
  }
  return body;
}

function tokenLooksExpired() {
  const claims = decodeJwtPayload(getAccessToken());
  if (!claims || claims.exp == null) return false;
  // Renew slightly early, so a token cannot expire between this check and the
  // server reading it.
  return Number(claims.exp) * 1000 - 30_000 <= Date.now();
}

// The in-flight renewal, shared by concurrent callers. See renewOnce.
let renewal = null;

/**
 * Trade the stored refresh token for a fresh access token.
 *
 * This is a public operation, so the refresh token is posted rather than the
 * expired access token, and no privileged credential is involved.
 */
async function renewSession() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  const base = String(import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
  const response = await fetch(`${base}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.access_token) {
    // A refresh token GoTrue will not accept is a signed-out session, not a
    // transient error. Clearing it stops every later request from retrying.
    clearAccessToken();
    throw new Error(
      body?.detail || 'Your session has ended. Please sign in again.',
    );
  }
  setAccessToken(body.access_token);
  // Supabase rotates the refresh token on every renewal, so the replacement
  // has to be stored: the old one is dead the moment this succeeds.
  if (body.refresh_token) setRefreshToken(body.refresh_token);
  return body.access_token;
}

// Concurrent callers must share one renewal. Supabase invalidates a refresh
// token when it is used, so a second concurrent request would present a token
// the first had just consumed and sign the user out mid-session.
function renewOnce() {
  if (!renewal) {
    renewal = renewSession().finally(() => {
      renewal = null;
    });
  }
  return renewal;
}

/**
 * Issue an authenticated backend request, renewing the access token first if
 * the stored one has expired.
 *
 * The `exp` claim is a hint, not an authority: the backend verifies every
 * token regardless, so a wrong guess here costs one wasted request and never a
 * wrong authorization. The local issuer mints no refresh token, in which case
 * there is nothing to renew and the request simply goes out as it is.
 */
async function authenticatedRequest(path, options = {}) {
  if (tokenLooksExpired()) {
    try {
      await renewOnce();
    } catch {
      // Fall through so the request itself reports the failure, once and in
      // the same shape as any other authentication error.
    }
  }
  return backendRequest(path, { ...options, auth: true });
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

/**
 * Persist a session envelope from the backend.
 *
 * The refresh token is optional: the local issuer mints stateless HS256 tokens
 * and returns an empty one, which is stored as "no refresh token" rather than
 * as a truthy empty string that a later renewal would try to use.
 */
function storeSession(result) {
  const token = result?.access_token || result?.token || '';
  if (!token) return '';
  setAccessToken(token);
  setRefreshToken(result?.refresh_token || '');
  return token;
}

export async function login({ email, password }) {
  if (BACKEND_AUTH) {
    const result = await backendRequest('/login', {
      method: 'POST',
      payload: { email, password },
    });
    const token = storeSession(result);
    if (!token) throw new Error('The backend returned no access token.');
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
    // With "Confirm email" enabled the backend creates the account and issues
    // no session. That is reported as-is: storing an empty credential and
    // treating the signup as a sign-in would fail on the first protected
    // request instead of telling the user to check their inbox.
    if (result.confirmation_required && !result.access_token) {
      return { user: result.user, token: '', confirmationRequired: true };
    }
    const token = storeSession(result);
    if (!token) throw new Error('The backend returned no access token.');
    return { user: result.user, token, confirmationRequired: false };
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
      // Renews an expired access token first, so reloading the app an hour
      // after signing in does not sign the user out.
      const result = await authenticatedRequest('/me');
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
      if (getAccessToken()) {
        // The refresh token is sent because it names the exact session to
        // destroy rather than whichever one the bearer happens to map to. The
        // access token is still required to authorize the revocation, so a
        // session whose access token has expired is renewed first -- otherwise
        // the server would report a successful sign-out while the refresh
        // token stayed live for the rest of its window. Renewing only when the
        // token is actually expired avoids rotating the refresh token on every
        // sign-out.
        if (tokenLooksExpired()) {
          try {
            await renewOnce();
          } catch {
            // Already signed out upstream. Sign out locally; there is nothing
            // left to revoke and the tokens are cleared either way.
          }
        }
        const refreshToken = getRefreshToken();
        await backendRequest('/logout', {
          method: 'POST',
          auth: true,
          payload: refreshToken ? { refreshToken } : {},
        });
      }
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

// The six account actions below are served by the FastAPI backend's
// Supabase Auth routes whenever the browser is holding a backend session. That
// covers `VITE_AUTH_MODE=backend` and also `external` when the host app has not
// installed a `window.__ECOMAI_OS_AUTH__` adapter -- in which case the
// provider owns sign-in but this service still owns account management, and
// routing it to the backend is the difference between the Settings page working
// and every action on it throwing.
//
// A real deployment never receives a reset token from the backend. The reset
// link is emailed by Supabase Auth and the recovery token comes back to the
// browser in the redirect URL's fragment; it is handed straight to
// `PUT /auth/v1/user` through this service and is never persisted.

function useBackendAccountApi() {
  if (BACKEND_AUTH) return true;
  if (REMOTE_AUTH) return typeof provider()?.requestPasswordReset !== 'function'
    && typeof provider()?.resetPassword !== 'function';
  return false;
}

export async function requestPasswordReset(email) {
  if (useBackendAccountApi()) {
    // Uniform response for a known and an unknown address alike: the backend
    // never discloses whether an account exists.
    await backendRequest('/password-reset', { method: 'POST', payload: { email } });
    return { ok: true, sent: true };
  }
  if (REMOTE_AUTH) {
    const hook = provider()?.requestPasswordReset || provider()?.resetPassword;
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
  if (useBackendAccountApi()) {
    await backendRequest('/reset-password', {
      method: 'POST',
      payload: { token, password },
    });
    return { ok: true };
  }
  if (REMOTE_AUTH) {
    return requireProvider('resetPassword')({ token, password });
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
  if (useBackendAccountApi()) {
    const body = await authenticatedRequest('/me', {
      method: 'PATCH',
      payload: {
        name: patch.name ?? undefined,
        businessName: patch.businessName ?? undefined,
        email: patch.email ?? undefined,
      },
    });
    return body.user;
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
  if (useBackendAccountApi()) {
    await authenticatedRequest('/change-password', {
      method: 'POST',
      payload: { currentPassword, newPassword },
    });
    return { ok: true };
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
  if (useBackendAccountApi()) {
    // Revokes the caller's other refresh tokens server-side. This is a real
    // state change, so it is not allowed to report success without a round
    // trip the way the old no-op did.
    await authenticatedRequest('/logout-all', { method: 'POST' });
    return { ok: true };
  }
  if (REMOTE_AUTH) {
    const hook = provider()?.logoutAllSessions;
    if (typeof hook !== 'function') {
      throw new Error(
        'Signing out other sessions is managed by the external identity provider.',
      );
    }
    return hook();
  }
  await latency(500);
  // In the mock there is one session; a real backend revokes refresh tokens.
  return { ok: true };
}

export async function deleteAccount(user, password) {
  if (useBackendAccountApi()) {
    const body = await authenticatedRequest('/me', {
      method: 'DELETE',
      payload: { password },
    });
    clearAccessToken();
    return { ok: true, deletedRows: body.deleted_rows ?? 0 };
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