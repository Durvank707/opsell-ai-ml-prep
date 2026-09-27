// Browser-side storage for externally issued credentials.
//
// The backend remains the only authority for identity: this store never
// decodes a token to select a tenant and never treats a mock-session hash as a
// JWT. sessionStorage avoids persisting a bearer token across browser restarts.
//
// A refresh token lives here too, under its own key, for the same reason: both
// are credentials, both belong to the same storage lifetime, and splitting them
// would leave a refresh token behind after a sign-out that only cleared the
// access token. It is never sent anywhere except POST /auth/refresh.

const TOKEN_KEY = 'ecomai.session.jwt.v1';
const REFRESH_KEY = 'ecomai.session.refresh.v1';
const AUTH_EXPIRED_EVENT = 'ecomai:auth-expired';

const MAX_TOKEN_LENGTH = 16_384;

function storage() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function readKey(key) {
  const value = storage()?.getItem(key) || '';
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function writeKey(key, value, label) {
  const target = storage();
  if (!target) return;
  if (value == null || value === '') {
    target.removeItem(key);
    return;
  }
  if (typeof value !== 'string' || value.length > MAX_TOKEN_LENGTH) {
    throw new Error(`The ${label} is invalid.`);
  }
  target.setItem(key, value.trim());
}

export function getAccessToken() {
  return readKey(TOKEN_KEY);
}

export function setAccessToken(token) {
  writeKey(TOKEN_KEY, token, 'access token');
}

export function getRefreshToken() {
  return readKey(REFRESH_KEY);
}

export function setRefreshToken(token) {
  writeKey(REFRESH_KEY, token, 'refresh token');
}

export function clearAccessToken() {
  const target = storage();
  if (!target) return;
  // Both go together. Clearing only the access token would leave a working
  // refresh token in the browser after a sign-out or an expiry.
  target.removeItem(TOKEN_KEY);
  target.removeItem(REFRESH_KEY);
}

export function notifyAuthExpired() {
  clearAccessToken();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
}

export function onAuthExpired(listener) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  window.addEventListener(AUTH_EXPIRED_EVENT, listener);
  return () => window.removeEventListener(AUTH_EXPIRED_EVENT, listener);
}

export { AUTH_EXPIRED_EVENT, REFRESH_KEY, TOKEN_KEY };
