// Shared CSV validate-then-commit helpers for the sales and products flows.
//
// Validation is the server's job in api mode: the browser does no canonical
// checking of its own beyond parsing the file into rows, because the canonical
// contract lives in `backend/contracts.py` and a second set of rules here would
// only be able to disagree with it. These helpers turn the server's validation
// report into the shape the upload UI draws.

import { parseCSV } from '../../lib/utils';
import * as http from './http';

/** Split a CSV into a header and raw source rows, without judging them. */
export function readCsv(csvText) {
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
 * The accepted subset of the parsed lines, so a commit sends only rows the
 * report cleared.
 *
 * The API numbers data rows from 1 and passes the header separately as
 * `columns`, so data row `n` is `rows[n - 1]` and `rows` never holds the header
 * at all. A row problem's `row_number` is in that numbering, and it is what has
 * to be matched here: resubmitting a rejected line would hand the server a batch
 * it refuses outright, since ingest is all-or-nothing.
 */
export function withoutRejectedRows(rows, errors) {
  const rejected = new Set(errors.map((error) => error.row));
  return rows.filter((_row, index) => !rejected.has(index + 1));
}

/**
 * The 1-based data-row numbers the report cleared, in file order.
 *
 * `withoutRejectedRows` answers the same question by value; this answers it by
 * position, so a caller that inspects each accepted row individually can still
 * name the line it came from. `toValidationReport` reports row numbers in this
 * numbering, so entry `i` here describes `payload[i]`.
 */
export function acceptedRowNumbers(rows, errors) {
  const rejected = new Set(errors.map((error) => error.row));
  return rows.map((_row, index) => index + 1).filter((number) => !rejected.has(number));
}

/** Poll an async validation job to completion (large-file uploads). */
export async function pollValidationJob(user, jobId) {
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

/** Map a server validation response to the report shape the upload UI draws. */
export function toValidationReport(report, sourceRows) {
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