// Browser-side storage for an externally issued access token.
//
// The backend remains the only authority for identity: this store never
// decodes a token to select a tenant and never treats a mock-session hash as a
// JWT. sessionStorage avoids persisting a bearer token across browser restarts.

const TOKEN_KEY = 'ecomai.session.jwt.v1';
const AUTH_EXPIRED_EVENT = 'ecomai:auth-expired';

function storage() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function getAccessToken() {
  const value = storage()?.getItem(TOKEN_KEY) || '';
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function setAccessToken(token) {
  const target = storage();
  if (!target) return;
  if (token == null || token === '') {
    target.removeItem(TOKEN_KEY);
    return;
  }
  if (typeof token !== 'string' || token.length > 16_384) {
    throw new Error('The access token is invalid.');
  }
  target.setItem(TOKEN_KEY, token.trim());
}

export function clearAccessToken() {
  storage()?.removeItem(TOKEN_KEY);
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

export { AUTH_EXPIRED_EVENT, TOKEN_KEY };
