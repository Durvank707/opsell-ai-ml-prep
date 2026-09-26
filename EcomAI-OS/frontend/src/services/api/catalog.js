// Catalog and inventory, backed by the tenant API.
//
// The product table is served from one request. `GET /inventory/overview`
// already computes the health bucket, the target stock and the 30-day forecast
// total for every product, so reading it once gives the table everything it
// renders without an N+1 sweep of per-product forecast calls.

import * as http from './http';
import { toInventoryOverview, toProduct, toTimeline } from './adapters';
import { requireApiSession } from './mode';

const URGENCY = { critical: 0, low: 1, overstocked: 2, healthy: 3 };

/** All products in one request, flattened out of the four health buckets. */
async function loadCatalog(user) {
  requireApiSession();
  const overview = await http.fetchInventoryOverview(user);
  const mapped = toInventoryOverview(overview);
  return [...mapped.critical, ...mapped.low, ...mapped.overstocked, ...mapped.healthy];
}

export async function getInventoryOverview(user) {
  const overview = await http.fetchInventoryOverview(user);
  return toInventoryOverview(overview);
}

export async function listProducts(user, filters = {}) {
  const {
    search = '',
    category = 'all',
    status = 'all',
    sort = 'urgency',
    page = 1,
    pageSize = 12,
  } = filters;

  let items = await loadCatalog(user);

  if (search) {
    const needle = String(search).toLowerCase();
    items = items.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.id.toLowerCase().includes(needle) ||
        p.sku.toLowerCase().includes(needle),
    );
  }
  if (category && category !== 'all') items = items.filter((p) => p.category === category);
  if (status && status !== 'all') items = items.filter((p) => p.status === status);

  const valueOf = (p) => p.currentStock * p.unitCost;
  switch (sort) {
    case 'name':
      items.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'stock':
      items.sort((a, b) => a.currentStock - b.currentStock);
      break;
    case 'value':
      items.sort((a, b) => valueOf(b) - valueOf(a));
      break;
    case 'urgency':
    default:
      items.sort((a, b) => {
        const byUrgency = URGENCY[a.status] - URGENCY[b.status];
        if (byUrgency !== 0) return byUrgency;
        return b.currentStock - a.currentStock;
      });
  }

  const total = items.length;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total, page, pageSize };
}

/**
 * One product, with the reorder decision the detail page shows.
 *
 * The metrics row, the reorder row and the product's own 30-day forecast are
 * fetched together because the reorder endpoint is what resolves the health
 * status, the target stock and the recommended quantity through the shared
 * inventory policy, and the summary tiles quote the forecast total the engine
 * just produced rather than a figure re-derived in the browser.
 */
export async function getProduct(user, productId) {
  requireApiSession();
  const [metrics, reorder, forecast] = await Promise.all([
    http.fetchProduct(user, productId),
    http.fetchReorder(user, productId),
    http.fetchProductForecast(user, productId, 30).catch(() => null),
  ]);

  const product = toProduct({ ...metrics, status: reorder.status });
  const leadTimeDays = Number(metrics.lead_time_days) || 0;
  const points = forecast?.points || [];
  // Demand inside the lead time, from the same forecast series the chart draws.
  // The engine's own `lead_time_demand` is the fallback for a product with too
  // little history to forecast; reporting null there would print the word
  // "null" into the decision sentence.
  const projectedDuringLeadTime = points.length
    ? Math.round(
        points
          .slice(0, Math.max(0, leadTimeDays))
          .reduce((sum, point) => sum + (Number(point.forecast) || 0), 0),
      )
    : metrics.lead_time_demand != null
      ? Math.round(Number(metrics.lead_time_demand))
      : null;

  return {
    ...product,
    // The policy engine's own target, not a browser-side re-derivation of it.
    targetStock: reorder.target_inventory ?? product.targetStock,
    recommendedOrderQty: reorder.recommended_order_qty,
    reorderRequired: reorder.reorder_required,
    trend: { trend: 'stable', growthPct: 0 },
    // A product too short on history to forecast reports no total, and the tile
    // renders an em dash rather than a zero dressed up as a projection.
    forecast30: forecast ? forecast.total : null,
    forecast30AvgDaily: forecast ? forecast.avgDaily : null,
    forecastFallbackUsed: forecast ? forecast.fallback_used ?? null : null,
    leadTimeDemand: metrics.lead_time_demand ?? null,
    projectedDemandDuringLeadTime: projectedDuringLeadTime,
  };
}

export async function updateStock(user, productId, newStock) {
  const updated = await http.patchProduct(user, productId, {
    current_stock: Math.max(0, Number(newStock)),
  });
  return toProduct(updated);
}

export async function getInventoryTimeline(user, productId, { days = 45 } = {}) {
  const raw = await http.fetchTimeline(user, productId, days);
  return toTimeline(raw);
}

export async function createProduct(user, payload) {
  const name = String(payload.name || '').trim();
  const productId = String(payload.productId || '').trim();
  if (!name) throw new Error('Please provide a product name.');
  if (!productId) throw new Error('Please provide a product ID.');

  const row = {
    product_id: productId,
    product_name: name,
    category: payload.category || 'Electronics',
    current_stock: Math.max(0, Number(payload.currentStock) || 0),
    lead_time_days: Math.max(0, Number(payload.leadTimeDays) || 7),
    unit_cost: Math.max(0, Number(payload.unitCost) || 0),
    unit_price: Math.max(0, Number(payload.sellingPrice) || 0),
  };
  if (Number(payload.minStock) > 0) row.safety_stock = Number(payload.minStock);
  if (payload.supplier) row.supplier = String(payload.supplier).trim();
  if (payload.description) row.description = String(payload.description).trim();

  const result = await http.postIngest(user, {
    recordType: 'product',
    rows: [row],
    columns: Object.keys(row),
  });
  // A duplicate product id is refused by the server's own uniqueness rules and
  // arrives as a 422; the workspace returns the written row.
  const created = await http.fetchProduct(user, productId);
  return toProduct({ ...created, ingested: result.ingested_rows });
}

export async function updateProduct(user, productId, payload) {
  const patch = {};
  if (payload.name !== undefined) patch.product_name = String(payload.name);
  if (payload.category !== undefined) patch.category = String(payload.category);
  if (payload.description !== undefined) patch.description = String(payload.description);
  if (payload.supplier !== undefined) patch.supplier = String(payload.supplier);
  if (payload.unitCost !== undefined) patch.unit_cost = Math.max(0, Number(payload.unitCost));
  if (payload.sellingPrice !== undefined) patch.unit_price = Math.max(0, Number(payload.sellingPrice));
  if (payload.currentStock !== undefined) {
    patch.current_stock = Math.max(0, Number(payload.currentStock));
  }
  // A zero minimum means "no floor set", and is left out of the patch so it
  // cannot silently clear a floor the tenant previously set.
  if (payload.minStock !== undefined && Number(payload.minStock) > 0) {
    patch.safety_stock = Number(payload.minStock);
  }
  if (payload.leadTimeDays !== undefined) {
    patch.lead_time_days = Math.max(0, Number(payload.leadTimeDays));
  }
  if (!Object.keys(patch).length) {
    const current = await http.fetchProduct(user, productId);
    return toProduct(current);
  }
  const updated = await http.patchProduct(user, productId, patch);
  return toProduct(updated);
}

export async function deleteProduct(user, productId) {
  const result = await http.removeProduct(user, productId);
  return { ok: true, salesRowsRemoved: result.sales_rows_removed };
}

/**
 * Record a purchase order against a product.
 *
 * The backend stores an absolute open-order quantity rather than a delta, so
 * the current value is read first and the sum is written back. A blind `+=`
 * against a stale read would lose an order placed in another tab.
 */
export async function placeSimulatedOrder(user, productId, qty) {
  const quantity = Math.max(0, Number(qty) || 0);
  const current = await http.fetchProduct(user, productId);
  const openOrderQty = (current.open_order_qty ?? 0) + quantity;
  await http.patchProduct(user, productId, { open_order_qty: openOrderQty });
  return { ok: true, openOrderQty };
}
