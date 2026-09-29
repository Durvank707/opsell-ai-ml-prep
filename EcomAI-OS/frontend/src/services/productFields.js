// The rules the add/edit product form and the product services share.
//
// These live in one place on purpose. The form shows the first problem before
// anything is sent, and the services re-check the same rules so a caller that
// skips the form (a keyboard shortcut, a test, a future screen) cannot create a
// product the form would have refused. Both report the same sentence, so the
// message a tenant reads does not depend on which one caught it.
//
// What is required and why:
//
//   Product ID      The catalog's own key. Required, and once chosen it is never
//                   editable, because sales history and forecasts are filed
//                   under it.
//   Product name    The only required display field: a row nobody can identify
//                   in a table is not usable.
//   Current stock   Physical units on hand. The engine reads this to compute
//                   inventory position; an empty value is not zero stock, it is
//                   an unknown stock level, and defaulting it to 0 would make
//                   the product look urgently out of stock.
//   Minimum stock   The reorder floor. Empty is not "no floor" — a tenant who has
//                   not set one has not answered the question yet.
//   Lead time       Days from order to receipt. Drives the reorder point, so an
//                   empty value silently changes every recommendation.
//
// Unit cost and selling price remain optional, and a blank one is stored as 0.
// Supplier and description stay optional: they are display-only, are never read
// by the model or the inventory engine, and a blank one costs nothing.

/** The exact sentence a tenant sees when a Product ID is already taken. */
export function duplicateProductMessage(productId) {
  return `Product ID ${productId} already exists in your catalog. Use a different Product ID or edit the existing product.`;
}

/** The same sentence, for the several-at-once case a CSV re-upload produces. */
export function duplicateProductsMessage(productIds) {
  const ids = Array.isArray(productIds) ? productIds.filter(Boolean) : [productIds];
  if (ids.length === 1) return duplicateProductMessage(ids[0]);
  return `Product IDs ${ids.join(', ')} already exist in your catalog. Use different Product IDs, or edit the existing products instead of re-creating them.`;
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/** A finite, non-negative number, or null. Rejects NaN, Infinity and junk. */
function nonNegativeNumber(value) {
  if (isBlank(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * The three stock fields that must be answered before a product can be created.
 *
 * Returned as a list rather than a boolean so the caller can name the field.
 */
export const REQUIRED_STOCK_FIELDS = [
  {
    key: 'currentStock',
    label: 'current stock (units on hand)',
    error: 'Please enter the current stock (units on hand).',
  },
  {
    key: 'minStock',
    label: 'minimum stock level',
    error: 'Please enter the minimum stock level.',
  },
  {
    key: 'leadTimeDays',
    label: 'lead time in days',
    error: 'Please enter the lead time in days.',
  },
];

/**
 * Validate a manual product payload.
 *
 * Returns '' when the payload is acceptable, otherwise the first problem as a
 * sentence the tenant can act on. `requireId` is false while editing, because an
 * existing product's ID is already fixed and is not part of the patch.
 */
export function validateProductInput(payload = {}, { requireId = true } = {}) {
  if (requireId && isBlank(payload.productId)) return 'Please enter a product ID.';
  if (isBlank(payload.name)) return 'Please enter a product name.';
  for (const field of REQUIRED_STOCK_FIELDS) {
    if (nonNegativeNumber(payload[field.key]) === null) {
      return `${field.error} Enter the ${field.label} as a number of 0 or more.`;
    }
  }
  // Unit cost and selling price stay optional, as they always were: a merchant
  // counting stock may not know either yet, and 0 is a real answer for both. A
  // value that *is* given still has to be a number, because a typo stored as 0
  // would silently rewrite the product's margin and every revenue figure built
  // on it.
  if (!isBlank(payload.unitCost) && nonNegativeNumber(payload.unitCost) === null) {
    return 'Please enter the unit cost as a number of 0 or more, or leave it empty.';
  }
  if (!isBlank(payload.sellingPrice) && nonNegativeNumber(payload.sellingPrice) === null) {
    return 'Please enter the selling price as a number of 0 or more, or leave it empty.';
  }
  return '';
}

/**
 * The one sentence a product import reports.
 *
 * All three counts are always stated, including the zeroes. "3 imported" on its
 * own reads as "everything in the file", which is exactly the wrong thing for a
 * tenant to believe about a file that also contained products they already had.
 */
export function productImportMessage({ newProducts, skipped = 0, failed = 0 }) {
  return `New products: ${newProducts} / Existing/skipped: ${skipped} / Failed: ${failed}.`;
}

/**
 * Split a validated payload into the canonical product row the API ingests.
 *
 * The minimum stock is written even when it is zero: on a create, zero is the
 * answer the tenant gave ("no floor"), not an absence, and the catalog column is
 * nullable so the value round-trips instead of being dropped.
 */
export function toCanonicalProductRow(payload = {}) {
  const row = {
    product_id: String(payload.productId).trim(),
    product_name: String(payload.name).trim(),
    category: String(payload.category || '').trim() || 'Electronics',
    current_stock: nonNegativeNumber(payload.currentStock) ?? 0,
    // 7 is unreachable through `validateProductInput`, which requires the field;
    // it stays as the documented default so a caller that skips validation gets
    // the value the form used to send rather than a zero-day lead time.
    lead_time_days: nonNegativeNumber(payload.leadTimeDays) ?? 7,
    safety_stock: nonNegativeNumber(payload.minStock) ?? 0,
    unit_cost: nonNegativeNumber(payload.unitCost) ?? 0,
    unit_price: nonNegativeNumber(payload.sellingPrice) ?? 0,
  };
  const supplier = String(payload.supplier || '').trim();
  if (supplier) row.supplier = supplier;
  const description = String(payload.description || '').trim();
  if (description) row.description = description;
  return row;
}
