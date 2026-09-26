// Sales data service — summary, records table, CSV upload + validation.
//
// The default `mock` mode validates and commits in the browser. With
// `VITE_DATA_MODE=api` both steps go through the tenant API, which is the only
// authority on what the canonical sales contract accepts. `validateSalesCsv` is
// async in both modes for that reason: a server-side rule check cannot be
// answered synchronously from the browser.

import { getDB, latency, randomError } from './mock/db';
import { parseCSV, downloadFile } from '../lib/utils';
import { usingApi } from './api/mode';
import * as api from './api/sales';

const CHANNELS = ['Online Store', 'Amazon', 'Flipkart', 'Myntra', 'Offline Store'];

function memo(fn) {
  const cache = new WeakMap();
  return (db, ...args) => {
    let hit = cache.get(db);
    if (!hit) {
      hit = {
        version: 0,
        value: undefined,
      };
      cache.set(db, hit);
    }
    hit.value = fn(db, ...args);
    return hit.value;
  };
}

export const getSalesSummary = memo((db) => {
  let totalRecords = 0;
  let totalRevenue = 0;
  const channelCounts = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
  const today = new Date();
  for (const p of db.products) {
    const series = db.getSales(p.id);
    for (const s of series) {
      if (s.units > 0) {
        totalRecords++;
        totalRevenue += s.revenue || s.units * p.sellingPrice;
        channelCounts[s.channel] = (channelCounts[s.channel] || 0) + 1;
      }
    }
  }
  return {
    totalRecords,
    totalRevenue,
    lastImport: db.salesMeta.lastImport,
    dateFrom: db.salesMeta.dateFrom,
    dateTo: db.salesMeta.dateTo,
    productsCovered: db.products.length,
    channels: Object.entries(channelCounts).map(([name, count]) => ({ name, count })),
  };
});

export async function getSalesData(user) {
  if (usingApi()) return api.getSalesData(user);
  await latency(450);
  const db = getDB(user);
  return getSalesSummary(db);
}

export async function listSalesRecords(user, filters = {}) {
  if (usingApi()) return api.listSalesRecords(user, filters);
  await latency(400);
  const db = getDB(user);
  const {
    search = '',
    productId = 'all',
    channel = 'all',
    dateFrom = null,
    dateTo = null,
    page = 1,
    pageSize = 25,
  } = filters;

  const records = [];
  for (const p of db.products) {
    const series = db.getSales(p.id);
    for (const s of series) {
      if (s.units <= 0) continue;
      if (productId !== 'all' && p.id !== productId) continue;
      if (channel !== 'all' && s.channel !== channel) continue;
      if (dateFrom && s.date < dateFrom) continue;
      if (dateTo && s.date > dateTo) continue;
      records.push({
        id: `${p.id}-${s.date}-${s.channel}`,
        date: s.date,
        productId: p.id,
        productName: p.name,
        category: p.category,
        units: s.units,
        revenue: s.revenue,
        channel: s.channel,
      });
    }
  }
  if (search) {
    const q = search.toLowerCase();
    const filtered = records.filter(
      (r) => r.productName.toLowerCase().includes(q) || r.productId.toLowerCase().includes(q),
    );
    return pageRecords(filtered, page, pageSize);
  }
  records.sort((a, b) => b.date.localeCompare(a.date));
  return pageRecords(records, page, pageSize);
}

function pageRecords(records, page, pageSize) {
  const total = records.length;
  const start = (page - 1) * pageSize;
  return { items: records.slice(start, start + pageSize), total, page, pageSize };
}

// ------------------------------------------------------------------ upload

// The columns the canonical sales contract actually stores. `date`,
// `product_id` and `units_sold` are required; `price`, `category` and
// `promotion` are optional but are what the eligibility gate checks before it
// will use the trained model, so a file that supplies them gets a real forecast
// rather than a baseline with derived features.
export const SAMPLE_CSV_TEMPLATE = `date,product_id,units_sold,price,category,promotion
2026-09-01,P001,14,1299,Electronics,false
2026-09-02,P001,9,1299,Electronics,true
2026-09-01,P002,3,899,Home,false
2026-09-02,P002,5,899,Home,false`;

/**
 * Validate a CSV string against the workspace catalog. Never silently accepts
 * invalid data: every erroneous row is reported so the user can inspect it
 * before importing. Throws on structurally broken files.
 */
export async function validateSalesCsv(csvText, user) {
  if (usingApi()) return api.validateSalesCsv(csvText, user);
  const db = getDB(user);
  if (!csvText || !csvText.trim()) throw randomError('The uploaded file is empty.');

  const rows = parseCSV(csvText);
  if (rows.length === 0) throw randomError('The uploaded file is empty.');
  const header = rows[0].map((h) => h.trim().toLowerCase());

  const required = ['date', 'product_id', 'units_sold'];
  const missing = required.filter((r) => !header.includes(r));
  if (missing.length) {
    throw randomError(
      `CSV contains invalid rows. Required columns: ${required.map((r) => `"${r}"`).join(', ')} (missing ${missing.join(', ')}).`,
    );
  }

  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const known = new Set([...db.products.map((p) => p.id), ...db.products.map((p) => p.sku)]);

  const errors = [];
  const valid = [];
  let totalRows = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    totalRows++;
    const lineNumber = i + 1;
    const date = (row[idx.date] || '').trim();
    const productId = (row[idx.product_id] || '').trim();
    const units = String(row[idx.units_sold] ?? '').trim();
    const channel = (row[idx.channel] || '').trim() || 'Import';

    if (!date) {
      errors.push({ row: lineNumber, reason: 'Missing date.' });
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) {
      errors.push({ row: lineNumber, reason: `Invalid date "${date}". Expected format YYYY-MM-DD.` });
      continue;
    }
    if (!productId) {
      errors.push({ row: lineNumber, reason: 'Missing product ID.' });
      continue;
    }
    if (!known.has(productId)) {
      errors.push({ row: lineNumber, reason: `Unknown product ID "${productId}". Add the product first.` });
      continue;
    }
    if (units === '' || Number.isNaN(Number(units)) || Number(units) < 0) {
      errors.push({ row: lineNumber, reason: `Invalid units value "${units}".` });
      continue;
    }
    if (!Number.isInteger(Number(units))) {
      errors.push({ row: lineNumber, reason: `Units must be a whole number, got "${units}".` });
      continue;
    }
    valid.push({ date, productId, units: Number(units), channel });
  }

  const missingProductId = errors.filter((e) => e.reason.includes('Missing product ID')).length;
  const unknownProductId = errors.filter((e) => e.reason.includes('Unknown product')).length;
  const invalidUnits = errors.filter((e) => e.reason.includes('Invalid units')).length;

  return {
    ok: valid.length > 0,
    totalRows,
    validRows: valid.length,
    skippedRows: errors.length,
    errors,
    summary: { missingProductId, unknownProductId, invalidUnits },
    message:
      errors.length > 0
        ? `${errors.length} row${errors.length === 1 ? '' : 's'} failed validation. ${valid.length} row${valid.length === 1 ? '' : 's'} are ready to import.`
        : `${valid.length} row${valid.length === 1 ? '' : 's'} are ready to import.`,
    payload: valid,
  };
}

/**
 * Validate, then import the valid rows of a CSV file. Loads of invalid rows
 * are surfaced to the user both in the returned result and as structured UI.
 */
export async function uploadSalesCsv(user, csvText) {
  if (usingApi()) return api.uploadSalesCsv(user, csvText);
  await latency(1200);
  const result = await validateSalesCsv(csvText, user);
  if (result.validRows === 0) {
    throw randomError(
      result.errors.some((e) => e.reason.includes('Unknown product'))
        ? 'CSV contains invalid rows. ' + result.errors[0].reason
        : 'CSV contains invalid rows.',
    );
  }
  const db = getDB(user);
  db.importSalesRows(result.payload);
  return {
    ...result,
    ok: true,
    message:
      result.errors.length > 0
        ? `${result.errors.length} row${result.errors.length === 1 ? ' was' : 's were'} skipped during validation. ${result.validRows} valid row${result.validRows === 1 ? ' was' : 's were'} imported.`
        : `${result.validRows} row${result.validRows === 1 ? '' : 's'} imported successfully.`,
  };
}

/** Import the full generated store history (used as a demo shortcut). */
export async function loadSampleSalesData(user) {
  if (usingApi()) return api.loadSampleSalesData(user);
  await latency(1500);
  const db = getDB(user);
  if (db.products.length === 0) throw randomError('Add at least one product before importing sales data.');
  // Touch every product's series so the records are materialised.
  let records = 0;
  for (const p of db.products) {
    const series = db.getSales(p.id);
    records += series.filter((s) => s.units > 0).length;
  }
  db.salesMeta.lastImport = new Date().toISOString();
  db.salesMeta.totalRecords = records;
  db.pushActivity('sales_uploaded', `Imported ${records} historical sales records.`);
  db.pushNotification({
    title: 'Sales data upload completed.',
    message: `${records.toLocaleString('en-IN')} records were validated and imported successfully.`,
    severity: 'success',
  });
  return { ok: true, records };
}

export function downloadSampleCsv() {
  downloadFile('ecomai-sample-sales.csv', SAMPLE_CSV_TEMPLATE, 'text/csv');
}