// Where business data comes from.
//
// VITE_DATA_MODE selects the source for every service call:
//
//   'api'   the FastAPI backend, which is the only authority. Failures are
//           surfaced to the caller; nothing ever falls back to demo data.
//   'mock'  the deterministic in-browser store, so the UI stays runnable with
//           no backend at all. This is the default.
//
// The mode is read once from the build-time environment. An unrecognised value
// is a build error rather than a default: silently serving generated numbers to
// someone who asked for their real data is the one failure mode this whole
// layer exists to prevent, so it is better to fail at startup than to look
// like it is working.

import { getAccessToken } from '../../api/tokenStore';

const RAW_MODE = String(import.meta.env.VITE_DATA_MODE || 'mock')
  .trim()
  .toLowerCase();

const KNOWN_MODES = ['api', 'mock'];

if (!KNOWN_MODES.includes(RAW_MODE)) {
  throw new Error(
    `VITE_DATA_MODE must be one of ${KNOWN_MODES.join(' | ')}; got "${RAW_MODE}".`,
  );
}

export const DATA_MODE = RAW_MODE;

/** True when business data must come from the backend. */
export function usingApi() {
  return DATA_MODE === 'api';
}

/**
 * The tenant every V2 request is scoped by.
 *
 * This is the id the auth layer got back from the identity provider, which for
 * a real provider is the signed subject itself. It is never derived here, and
 * the server re-checks it against the token, so a caller cannot widen its own
 * scope by editing a request.
 */
export function tenantId(user) {
  const id = user?.id;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('No signed-in tenant is available for this request.');
  }
  return id.trim();
}

/**
 * Fail with an actionable message when the two modes disagree.
 *
 * `VITE_DATA_MODE=api` needs a real access token. In mock auth mode there
 * isn't one, and every request would otherwise come back as a bare 401 that
 * reads like a server problem.
 */
export function requireApiSession() {
  if (!getAccessToken()) {
    throw new Error(
      'VITE_DATA_MODE=api needs a real access token, but none is stored. Sign ' +
        'in with VITE_AUTH_MODE=backend (or external) so the API can verify ' +
        'the tenant, or set VITE_DATA_MODE=mock to use the demo store.',
    );
  }
}
