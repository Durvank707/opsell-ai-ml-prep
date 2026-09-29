// Product search for the Forecast page.
//
// The page used to filter the portfolio forecast rows with an ad-hoc
// comparison built inside the data loader. That comparison had two problems
// that a user experiences as "search is case sensitive":
//
//   1. The query was tested for emptiness with `search.trim()` but then used
//      untrimmed, so surrounding whitespace silently stopped every match.
//   2. It only ever searched the forecast rows. A product that has no forecast
//      row yet - a newly added product with no sales history - was not in that
//      list at all, so its name could not be found by any spelling.
//
// Matching now goes through one normalizer and runs against the catalog, so
// "Smart Fitness Band", "smart fitness band", "SMART FITNESS BAND" and
// "  Smart fitness BAND  " all resolve to the same product. The stored name
// and the stored product ID are never modified - only the comparison is
// normalized.

/** Trim and case-fold a query or a value that is about to be compared. */
export function normalizeQuery(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/** True when `product` is named or numbered by `query`. Empty query matches all. */
export function matchesQuery(query, product) {
  const needle = normalizeQuery(query);
  if (!needle) return true;
  if (!product) return false;
  return (
    normalizeQuery(product.name).includes(needle) ||
    normalizeQuery(product.id).includes(needle)
  );
}

/**
 * Catalog products matching `query`, in catalog order.
 *
 * An empty query returns nothing: no search means no product is selected, so
 * the caller keeps showing the portfolio forecast rather than the whole
 * catalog.
 */
export function searchProducts(products, query) {
  const needle = normalizeQuery(query);
  if (!needle) return [];
  return (products || []).filter((product) => matchesQuery(needle, product));
}
