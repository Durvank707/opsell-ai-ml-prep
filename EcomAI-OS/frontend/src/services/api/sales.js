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
import { parseCSV } from '../../lib/utils';
import { requireApiSession } from './mode';

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
 * The canonical sales contract has no channel, so the channel facet is not
 * something this query can honour: it is accepted for signature compatibility
 * and a non-"all" value is refused rather than quietly ignored, which would
 * return unfiltered rows under a filter that claims to be applied.
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

  if (channel && channel !== 'all') {
    throw new Error(
      'Sales records are not stored per channel, so this view cannot be filtered by channel.',
    );
  }

  const raw = await http.fetchSales(user, {
    productId,
    dateFrom,
    dateTo,
    search,
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
function readCsv(csvText) {
  if (!csvText || !csvText.trim()) throw new Error('The uploaded file is empty.');
  const table = parseCSV(csvText);
  if (table.length === 0) throw new Error('The uploaded file is empty.');
  const columns = table[0].map((cell) => cell.trim());
  const rows = table
    .slice(1)
    .map((cells) => {
      const row = {};
      columns.forEach((column, index) => {
        row[column] = cells[index] ?? '';
      });
      return row;
    });
  return { columns, rows };
}

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

async function pollValidationJob(user, jobId) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const job = await http.fetchValidationJob(user, jobId);
    if (job.status === 'succeeded') return job.result;
    if (job.status === 'failed') {
      throw new Error(job.error || 'The validation job failed.');
    }
    if (Date.now() > deadline) {
      throw new Error('Validation is taking longer than expected. Please try again.');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * The accepted subset of the parsed lines, so a commit sends only rows the
 * report cleared.
 *
 * The API numbers data rows from 1 and passes the header separately as
 * `columns`, so data row `n` is `rows[n - 1]` and `rows` never holds the header
 * at all. A row problem's `row_number` is in that numbering, and it is what has
 * to be matched here: resubmitting a rejected line would hand the server a batch
 * it refuses outright, since ingest is all-or-nothing.
 */
function withoutRejectedRows(rows, errors) {
  const rejected = new Set(errors.map((error) => error.row));
  return rows.filter((_row, index) => !rejected.has(index + 1));
}

function toValidationReport(report, sourceRows) {
  const problems = [...(report.problems || []), ...(report.schema_problems || [])];
  const errors = problems
    .filter((problem) => problem.severity === 'error')
    .map((problem) => ({
      row: problem.row_number,
      reason: problem.detail || 'This row failed validation.',
      category: problem.category,
      severity: problem.severity,
      field: problem.field,
      rawValue: problem.raw_value,
      resolution: problem.resolution,
    }));

  const accepted = report.accepted_rows ?? 0;
  const total = report.total_rows ?? sourceRows.length;

  // The source lines for the accepted rows, kept so the commit can send the
  // original text and let the server canonicalise it with the same rules it
  // just validated against.
  const payload = withoutRejectedRows(sourceRows, errors);

  return {
    ok: accepted > 0,
    totalRows: total,
    validRows: accepted,
    skippedRows: errors.length,
    errors,
    summary: {
      missingProductId: errors.filter((e) => e.category === 'missing_required' && e.field === 'product_id').length,
      unknownProductId: errors.filter((e) => /not in your catalog/i.test(e.reason)).length,
      invalidUnits: errors.filter((e) => /units_sold/.test(e.field || '')).length,
    },
    warnings: problems
      .filter((problem) => problem.severity === 'warn')
      .map((problem) => ({
        row: problem.row_number,
        reason: problem.detail,
        category: problem.category,
        resolution: problem.resolution,
      })),
    message:
      errors.length > 0
        ? `${errors.length} row${errors.length === 1 ? '' : 's'} failed validation. ${accepted} row${accepted === 1 ? '' : 's'} are ready to import.`
        : `${accepted} row${accepted === 1 ? '' : 's'} are ready to import.`,
    payload,
  };
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
