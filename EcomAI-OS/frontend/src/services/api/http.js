// The one HTTP surface the service layer talks to.
//
// Every business read and write goes through here so tenant scoping, bearer
// injection and error shape are decided in a single place. Endpoints are named
// for what they return rather than wrapped generically, because each one has a
// real, non-obvious contract (a 413 means "too many rows", a 503 means
// "Supabase is unreachable", a 403 means "not your tenant") and those
// distinctions are worth keeping visible at the call site.
//
// Request bodies are handed to `request` as plain objects, never pre-serialized:
// `request` sets `Content-Type: application/json` itself for a non-string body,
// so a `JSON.stringify` here would ship a JSON *string* and the server would
// reject it as "input should be a valid object".

import { requestV2 } from '../../api/client';
import { requireApiSession, tenantId } from './mode';

function tenantParams(user, extra = {}) {
  requireApiSession();
  return new URLSearchParams({ user_id: tenantId(user), ...extra }).toString();
}

function query(user, extra = {}) {
  return `?${tenantParams(user, extra)}`;
}

// ---------------------------------------------------------------- catalog

export function fetchProducts(user) {
  return requestV2(`/products${query(user)}`);
}

export function fetchProduct(user, productId) {
  return requestV2(
    `/products/${encodeURIComponent(productId)}${query(user)}`,
  );
}

export function patchProduct(user, productId, patch) {
  return requestV2(`/products/${encodeURIComponent(productId)}${query(user)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function removeProduct(user, productId) {
  return requestV2(`/products/${encodeURIComponent(productId)}${query(user)}`, {
    method: 'DELETE',
  });
}

export function fetchInventoryOverview(user) {
  return requestV2(`/inventory/overview${query(user)}`);
}

export function fetchReorder(user, productId, { moq = 0, packSize = 1 } = {}) {
  return requestV2(
    `/inventory/reorder/${encodeURIComponent(productId)}${query(user, {
      moq: String(moq),
      pack_size: String(packSize),
    })}`,
  );
}

export function fetchTimeline(user, productId, days = 45) {
  return requestV2(
    `/inventory/timeline/${encodeURIComponent(productId)}${query(user, {
      days: String(days),
    })}`,
  );
}

// ---------------------------------------------------------------- sales

export function fetchSales(user, { productId, dateFrom, dateTo, search, limit, offset } = {}) {
  const extra = {};
  if (productId && productId !== 'all') extra.product_id = productId;
  if (dateFrom) extra.date_from = dateFrom;
  if (dateTo) extra.date_to = dateTo;
  if (search) extra.search = search;
  if (limit != null) extra.limit = String(limit);
  if (offset != null) extra.offset = String(offset);
  return requestV2(`/sales${query(user, extra)}`);
}

export function fetchSalesSummary(user) {
  return requestV2(`/sales/summary${query(user)}`);
}

/**
 * Load the canonical demo dataset into the calling tenant.
 *
 * A write, so it is a POST. The server scopes it to the signed subject and
 * refuses it for a workspace that already holds products.
 */
export function postDemoSeed(user, { limit = null } = {}) {
  const body = { user_id: tenantId(user) };
  if (limit != null) body.limit = Number(limit);
  return requestV2('/demo/seed', { method: 'POST', body });
}

/**
 * Validate rows against the canonical contract without writing anything.
 *
 * A file over the server's inline limit comes back as 202 + a job id rather
 * than a report, so the caller has to poll `fetchValidationJob`.
 */
export function postValidate(user, { rows, columns, recordType = 'sales' }) {
  return requestV2('/validate', {
    method: 'POST',
    body: { user_id: tenantId(user), record_type: recordType, rows, columns },
  });
}

export function fetchValidationJob(user, jobId) {
  return requestV2(`/jobs/${encodeURIComponent(jobId)}${query(user)}`);
}

/**
 * Commit canonical rows. All-or-nothing: the server refuses the whole batch
 * with 422 and writes nothing if any row fails, so a half-ingested history is
 * not a state this call can produce.
 */
export function postIngest(user, { rows, columns, recordType = 'sales' }) {
  return requestV2('/ingest', {
    method: 'POST',
    body: { user_id: tenantId(user), record_type: recordType, rows, columns },
  });
}

// ---------------------------------------------------------------- intelligence

export function fetchPortfolioForecast(user, { horizon = 30, category = null } = {}) {
  const extra = { horizon: String(horizon) };
  if (category && category !== 'all') extra.category = category;
  return requestV2(`/forecast/portfolio${query(user, extra)}`);
}

export function fetchProductForecast(user, productId, horizon = 30) {
  return requestV2(
    `/forecast/${encodeURIComponent(productId)}${query(user, { horizon: String(horizon) })}`,
  );
}

export function fetchRecommendations(user, category = null) {
  const extra = {};
  if (category && category !== 'all') extra.category = category;
  return requestV2(`/recommendations${query(user, extra)}`);
}

export function postBacktest(user, body) {
  return requestV2(`/simulation/backtest${query(user)}`, {
    method: 'POST',
    body,
  });
}

// ---------------------------------------------------------------- workspace

export function fetchTenantOverview(user) {
  return requestV2(`/overview/${encodeURIComponent(tenantId(user))}`);
}

export function fetchAudit(user) {
  return requestV2(`/audit/${encodeURIComponent(tenantId(user))}`);
}
