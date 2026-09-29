// Catalog and inventory, backed by the tenant API.
//
// The product table is served from one request. `GET /inventory/overview`
// already computes the health bucket, the target stock and the 30-day forecast
// total for every product, so reading it once gives the table everything it
// renders without an N+1 sweep of per-product forecast calls.

import * as http from './http';
import { toInventoryOverview, toProduct, toTimeline } from './adapters';
import { requireApiSession } from './mode';
import { pollValidationJob, acceptedRowNumbers, readCsv, toValidationReport } from './validation';
import {
  duplicateProductMessage,
  duplicateProductsMessage,
  productImportMessage,
  toCanonicalProductRow,
  validateProductInput,
} from '../productFields';

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

/**
 * Create one product in the caller's catalog.
 *
 * The form's rules are re-checked here so this path cannot create a product the
 * form would have refused. The row goes to the canonical product contract, and
 * the server refuses a `product_id` the tenant already has using the sentence
 * this app shares with it — a create never overwrites an existing product.
 */
export async function createProduct(user, payload) {
  const problem = validateProductInput(payload);
  if (problem) throw new Error(problem);
  const productId = String(payload.productId).trim();
  const row = toCanonicalProductRow(payload);

  const result = await http.postIngest(user, {
    recordType: 'product',
    rows: [row],
    columns: Object.keys(row),
  });
  // The create either wrote the row or raised, so a 200 here means the product
  // exists and this is what the tenant will now see.
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

// ---------------------------------------------------------------- CSV import

/**
 * Validate a CSV against the canonical product contract. Writes nothing.
 *
 * Mirrors the sales flow: the browser only parses the file into rows, the
 * server's report decides everything, and large files are polled to completion.
 *
 * The one thing the server cannot know is which products this tenant already
 * has, so that check is made here and folded into the same report — a row the
 * catalog already holds is reported as such and excluded from the commit, and
 * the counts (new / already existed / failed) are the ones the upload UI shows.
 */
export async function validateProductsCsv(csvText, user) {
  requireApiSession();
  const { columns, rows } = readCsv(csvText);
  let report = await http.postValidate(user, {
    rows,
    columns,
    recordType: 'product',
  });
  if (report && report.job_id) {
    report = await pollValidationJob(user, report.job_id);
  }
  return excludeExistingProducts(user, toValidationReport(report, rows), rows);
}

/**
 * Drop rows the catalog already has, and report them instead of hiding them.
 *
 * A product id this tenant already holds is a conflict, not an update: replacing
 * it would discard the name, supplier, price and stock stored under that id. The
 * rows are removed from `payload` and named in `errors`, so a file that
 * re-uploads yesterday's catalog imports only what is new and the tenant can see
 * exactly which products were left alone. Comparison folds case, because `p001`
 * after `P001` is the same product in every table a merchant reads.
 */
/**
 * A product id, folded so two spellings of the same id compare equal.
 *
 * `p001` after `P001` is the same product in every table a merchant reads.
 * This lower-cases rather than using `String.prototype.casefold`, which is not
 * present in every engine this app runs on — and a missing built-in here would
 * fail the entire import rather than one comparison.
 */
function fold(productId) {
  return String(productId ?? '').trim().toLowerCase();
}

async function excludeExistingProducts(user, result, sourceRows) {
  const known = await existingProductIds(user);
  const numbers = acceptedRowNumbers(sourceRows, result.errors);
  const errors = [...result.errors];
  const toCreate = [];
  const alreadyPresent = [];
  const seen = new Set();

  result.payload.forEach((row, index) => {
    const productId = String(row.product_id ?? '').trim();
    // A row with no id at all was already reported by the contract check above;
    // it is carried through to the commit unchanged rather than judged twice.
    if (!productId) {
      toCreate.push(row);
      return;
    }
    const key = fold(productId);
    if (known.has(key)) {
      if (!alreadyPresent.includes(productId)) alreadyPresent.push(productId);
      errors.push({
        row: numbers[index],
        reason: duplicateProductMessage(productId),
        category: 'existing_product',
        severity: 'error',
      });
      return;
    }
    if (seen.has(key)) {
      errors.push({
        row: numbers[index],
        reason: `Product ID ${productId} appears more than once in this file.`,
        category: 'duplicate_in_file',
        severity: 'error',
      });
      return;
    }
    seen.add(key);
    toCreate.push(row);
  });

  const skippedExisting = alreadyPresent.length;
  return {
    ...result,
    ok: toCreate.length > 0,
    validRows: toCreate.length,
    skippedRows: errors.length,
    errors,
    existingProductIds: alreadyPresent,
    payload: toCreate,
    summary: { ...result.summary, existing: skippedExisting },
    message: productImportMessage({
      newProducts: toCreate.length,
      skipped: skippedExisting,
      failed: errors.length - skippedExisting,
    }),
  };
}

/**
 * Validate, then commit the rows the report cleared into the catalog.
 *
 * Existing products are detected *before* anything is committed: a
 * `product_id` the tenant already has is not sent, so a re-uploaded file adds
 * the new products and leaves the existing ones exactly as they were. The
 * result reports the three counts that make that visible — new, skipped as
 * already present, and failed — because a silently smaller catalog is the one
 * outcome a tenant cannot notice.
 *
 * The server is the backstop rather than the only guard: it refuses a duplicate
 * id outright, so a product created in another tab between the check and the
 * commit still cannot be overwritten.
 */
export async function uploadProductsCsv(user, csvText) {
  const result = await validateProductsCsv(csvText, user);
  if (result.payload.length === 0) {
    const existing = result.existingProductIds;
    throw new Error(
      existing.length
        ? `No new products were imported. ${duplicateProductsMessage(existing)}`
        : 'CSV contains invalid rows. ' + (result.errors[0]?.reason || ''),
    );
  }
  const { columns } = readCsv(csvText);
  const ingested = await http.postIngest(user, {
    rows: result.payload,
    columns,
    recordType: 'product',
  });
  const newProducts = ingested.ingested_rows;
  return {
    ...result,
    ok: true,
    newProducts,
    skippedExisting: result.summary.existing,
    failed: result.skippedRows - result.summary.existing,
    ingestedRows: newProducts,
    persistedTo: ingested.persisted_to,
    durable: Boolean(ingested.durable),
  };
}

/** Every `product_id` this tenant already has, folded for comparison. */
async function existingProductIds(user) {
  const products = await http.fetchProducts(user);
  return new Set(
    (Array.isArray(products?.products) ? products.products : [])
      .map((product) => String(product?.product_id ?? '').trim())
      .filter(Boolean)
      .map((productId) => fold(productId)),
  );
}

/**
 * Download the CSV upload template for the product catalog.
 *
 * The header is exactly the columns the product importer accepts and the
 * example rows import cleanly.
 */
export async function downloadProductTemplate(user) {
  requireApiSession();
  return http.fetchTemplate(user, 'product');
}
