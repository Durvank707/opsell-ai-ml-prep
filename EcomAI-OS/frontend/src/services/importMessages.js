// The sentences the import flows refuse a file with.
//
// A refusal has to name what was wrong and what to do about it, or the tenant
// re-uploads the same file. These live here rather than in a page so the mock
// store and the api path can only ever say one thing about the same problem:
// the api path takes the sentence from the server, and the mock store builds it
// with the function below, so the two stay word-for-word identical.

/**
 * How many unknown product ids a refused sales file names before the list is
 * summarised instead. A mis-keyed column can name hundreds, and the point of
 * the message is that the file was refused and why, not to paste the column
 * back.
 */
export const UNKNOWN_SALES_PRODUCTS_LIMIT = 10;

/**
 * Why a sales file was refused, naming the ids and the fix.
 *
 * Sales rows never create catalog entries: the catalog is the tenant's own
 * metadata, so a product that is not in it is an error rather than a warning.
 * This mirrors `unknown_sales_products_message` in `backend/routers/v2.py`.
 */
export function unknownSalesProductsMessage(productIds) {
  const ids = (Array.isArray(productIds) ? productIds : [productIds])
    .map((productId) => String(productId).trim())
    .filter(Boolean);
  const count = ids.length;
  const listed = ids.slice(0, UNKNOWN_SALES_PRODUCTS_LIMIT);
  const remainder = count - listed.length;
  const shown = remainder > 0 ? `${listed.join(', ')}, and ${remainder} more` : listed.join(', ');
  const plural = count === 1 ? '' : 's';
  return (
    `Sales import contains ${count} product ID${plural} that ` +
    `${count === 1 ? 'is' : 'are'} not in your catalog: ${shown}. ` +
    `Add ${count === 1 ? 'this product' : 'these products'} to your catalog ` +
    'first, then upload the sales data.'
  );
}
