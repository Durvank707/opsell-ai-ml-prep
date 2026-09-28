// Sales history: the records table, and the CSV validate-then-commit flow.
//
// Validation is the server's job in this mode. The browser does no canonical
// checking of its own beyond parsing the file into rows, because the canonical
// contract lives in `backend/contracts.py` and a second set of rules here would
// only be able to disagree with it.
//
// The commit is all-or-nothing on the server: a row that fails canonical
// validation refuses the whole batch. So the flow is validate (read-only,
// nothing written) -> the user reviews the report -> commit the accepted rows.
// Rows the report flagged are not sent, and the count of them is stated in the
// result so nothing is dropped silently.

import * as http from './http';
import { toSalesRecord, toSalesSummary } from './adapters';
import { requireApiSession } from './mode';
import { pollValidationJob, readCsv, toValidationReport } from './validation';

export async function getSalesData(user) {
  // "Last import" is the moment this tenant last committed sales rows. The
  // summary endpoint reports totals and a date range, not a write timestamp, and
  // the audit trail is where every committed batch is recorded, so the two are
  // read together. Hardcoding `null` here would tell a tenant with 1,000
  // imported rows that it has never imported anything.
  const [raw, audit] = await Promise.all([
    http.fetchSalesSummary(user),
    http.fetchAudit(user).catch(() => null),
  ]);
  const lastImport =
    (audit?.audit || [])
      .filter((entry) => entry.action === 'sales_upserted' && entry.created_at)
      .map((entry) => String(entry.created_at))
      .sort()
      .pop() || null;
  return { ...toSalesSummary(raw), lastImport };
}

/**
 * The page the records table shows.
 *
 * `channel` filters on the stored selling-channel label. The UI shows
 * "Not recorded" for the sentinel, so the page passes the sentinel back
 * verbatim and the translation happens once, in the adapter, rather than
 * here and in `ChannelBadge` separately.
 */
export async function listSalesRecords(user, filters = {}) {
  const {
    search = '',
    productId = 'all',
    channel = 'all',
    dateFrom = null,
    dateTo = null,
    page = 1,
    pageSize = 25,
  } = filters;

  const raw = await http.fetchSales(user, {
    productId,
    dateFrom,
    dateTo,
    search,
    channel: channel === 'all' ? null : channel,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return {
    items: (raw.rows || []).map(toSalesRecord),
    total: raw.total ?? 0,
    page,
    pageSize,
  };
}

/** Split a CSV into a header and raw source rows, without judging them. */

/**
 * Validate a CSV against the canonical sales contract. Writes nothing.
 *
 * Large files come back from the API as a job id instead of an inline report,
 * so the job is polled to completion here rather than being handed to the page
 * as a half-finished answer.
 */
export async function validateSalesCsv(csvText, user) {
  requireApiSession();
  const { columns, rows } = readCsv(csvText);

  let report = await http.postValidate(user, { rows, columns });
  if (report && report.job_id) {
    report = await pollValidationJob(user, report.job_id);
  }
  return toValidationReport(report, rows);
}

/**
 * Download the CSV upload template for sales history.
 *
 * The header is exactly the columns the canonical sales contract accepts and
 * the example rows import cleanly, so a new tenant can model its own file on it
 * instead of guessing.
 */
export async function downloadSalesTemplate(user) {
  requireApiSession();
  return http.fetchTemplate(user, 'sales');
}

/**
 * Load the canonical demo dataset into the calling tenant.
 *
 * The server reads it from the same on-disk raw store the training pipeline
 * uses, so this is the real dataset rather than a generated one. The server
 * refuses it for a workspace that already holds products, so pressing the button
 * can never overwrite real catalog data.
 */
export async function loadSampleSalesData(user) {
  const result = await http.postDemoSeed(user);
  return { ok: true, records: result.sales_rows, products: result.products };
}

/** Validate, then commit the rows the report accepted. */
export async function uploadSalesCsv(user, csvText) {
  const result = await validateSalesCsv(csvText, user);
  if (result.validRows === 0) {
    const unknown = result.errors.find((error) => error.category === 'missing_required');
    throw new Error(
      unknown
        ? 'CSV contains invalid rows. ' + result.errors[0].reason
        : 'CSV contains invalid rows.',
    );
  }

  const { columns } = readCsv(csvText);
  // `result.payload` is these same parsed rows minus every line the report
  // flagged, so the commit never carries a row the server would refuse.
  const ingested = await http.postIngest(user, { rows: result.payload, columns });

  const skipped = result.errors.length;
  return {
    ...result,
    ok: true,
    ingestedRows: ingested.ingested_rows,
    persistedTo: ingested.persisted_to,
    durable: Boolean(ingested.durable),
    message:
      skipped > 0
        ? `${skipped} row${skipped === 1 ? ' was' : 's were'} skipped during validation. ${result.validRows} valid row${result.validRows === 1 ? ' was' : 's were'} imported.`
        : `${result.validRows} row${result.validRows === 1 ? '' : 's'} imported successfully.`,
  };
}
