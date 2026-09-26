import {
  getAccessToken,
  notifyAuthExpired,
} from './tokenStore';

// Vite proxies /api during local development. Set VITE_API_BASE_URL for a
// separately hosted API; do not put a service-role key in this variable.
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

async function readResponse(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(payload, fallback) {
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (payload && typeof payload.detail === 'string' && payload.detail.trim()) {
    return payload.detail;
  }
  // The validation and ingest routes answer 422 with a structured detail that
  // carries the per-row problems, not a sentence. Take its `message` and, when
  // it reports failing rows, say how many so the caller knows a specific number
  // is at fault rather than the whole request.
  const detail = payload?.detail;
  if (detail && typeof detail === 'object') {
    const problems = [...(detail.problems || []), ...(detail.schema_problems || [])];
    if (problems.length) {
      const first = problems.find((p) => p?.severity === 'error') || problems[0];
      return `${detail.message || fallback} First problem: ${first.detail || first.field || 'unknown'}`;
    }
    if (typeof detail.message === 'string' && detail.message.trim()) return detail.message;
  }
  return fallback;
}

/**
 * Fetch a backend endpoint with optional bearer authentication.
 *
 * `auth: 'required'` is used for V2. `auth: 'none'` is useful for a future
 * provider login endpoint. Existing wrappers below remain V1-compatible.
 */
export async function request(path, {
  base = API_BASE,
  auth = 'optional',
  headers = {},
  ...init
} = {}) {
  const token = getAccessToken();
  if (auth === 'required' && !token) {
    throw new Error('Authentication is required.');
  }

  const finalHeaders = new Headers(headers);
  // A non-string body is a JSON document the caller handed over as an object.
  // `fetch` would stringify it to "[object Object]", so it is serialized here,
  // once, alongside the content type the server needs to parse it. A caller
  // that already holds a string is left alone.
  let body = init.body;
  if (body != null && typeof body !== 'string' && !finalHeaders.has('Content-Type')) {
    finalHeaders.set('Content-Type', 'application/json');
  }
  if (body != null && typeof body !== 'string') {
    body = JSON.stringify(body);
  }
  if (token && auth !== 'none') {
    finalHeaders.set('Authorization', `Bearer ${token}`);
  }

  const url = /^https?:\/\//i.test(path) ? path : `${base}${path}`;
  const response = await fetch(url, { ...init, body, headers: finalHeaders });
  const payload = await readResponse(response);
  if (response.status === 401 && token && auth !== 'none') {
    notifyAuthExpired();
  }
  if (!response.ok) {
    throw new Error(errorMessage(payload, `Request failed (${response.status})`));
  }
  return payload;
}

export function requestV1(path, options = {}) {
  return request(path, { ...options, base: options.base || API_BASE });
}

export function requestV2(path, options = {}) {
  return request(path, {
    ...options,
    base: options.base || `${API_BASE}/v2`,
    auth: 'required',
  });
}

export async function fetchHealth() {
  return requestV1('/health', { auth: 'none' });
}

export async function fetchProducts() {
  return requestV1('/products');
}

export async function fetchProduct(productId) {
  return requestV1(`/products/${encodeURIComponent(productId)}`);
}

export async function fetchInventoryOverview() {
  return requestV1('/inventory/overview');
}

export async function generateForecast(productId, horizon = 30, scenario = null) {
  const payload = {
    product_id: productId,
    horizon,
    scenario: scenario || null,
  };
  return requestV1('/forecast', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchReorderRecommendation(productId, moq = 0, packSize = 1) {
  const params = new URLSearchParams({
    moq: moq.toString(),
    pack_size: packSize.toString(),
  });
  return requestV1(
    `/inventory/reorder/${encodeURIComponent(productId)}?${params.toString()}`,
  );
}

export async function fetchStockoutTimeline(productId) {
  return requestV1(`/inventory/timeline/${encodeURIComponent(productId)}`);
}

export async function runBacktest(requestPayload) {
  return requestV1('/simulation/backtest', {
    method: 'POST',
    body: JSON.stringify(requestPayload),
  });
}

// Small V2 helpers used by an authenticated shell or future feature modules.
// They intentionally require the real token store; no tenant id is derived in
// the browser. Callers pass the server-verified user id returned by their auth
// provider/profile response.
export function fetchTenantOverview(userId) {
  return requestV2(`/overview/${encodeURIComponent(userId)}`);
}

export function fetchTenantAudit(userId) {
  return requestV2(`/audit/${encodeURIComponent(userId)}`);
}

export function createValidationJob(userId, jobType = 'validation') {
  const params = new URLSearchParams({ user_id: userId, job_type: jobType });
  return requestV2(`/jobs?${params.toString()}`, { method: 'POST' });
}

export function fetchJobStatus(jobId, userId) {
  const params = new URLSearchParams({ user_id: userId });
  return requestV2(`/jobs/${encodeURIComponent(jobId)}?${params.toString()}`);
}

export { API_BASE };
