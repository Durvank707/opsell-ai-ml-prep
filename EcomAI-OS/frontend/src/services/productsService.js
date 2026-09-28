// Products service — create / update / delete operations.

import { getDB, latency, randomError } from './mock/db';
import { getSuppliers } from './mock/catalog';
import { usingApi } from './api/mode';
import * as api from './api/catalog';
import { downloadFile, parseCSV } from '../lib/utils';

export async function createProduct(user, payload) {
  if (usingApi()) return api.createProduct(user, payload);
  await latency(600);
  const db = getDB(user);
  if (!payload.name?.trim()) throw randomError('Please provide a product name.');
  if (!payload.productId?.trim()) throw randomError('Please provide a product ID.');
  const duplicate = db.products.find(
    (p) => p.id.toLowerCase() === payload.productId.trim().toLowerCase() || p.sku.toLowerCase() === payload.productId.trim().toLowerCase(),
  );
  if (duplicate) throw randomError('A product with this ID already exists.');
  const product = db.addProduct({
    productId: payload.productId.trim(),
    name: payload.name.trim(),
    category: payload.category || 'Electronics',
    description: payload.description || '',
    unitCost: payload.unitCost,
    sellingPrice: payload.sellingPrice,
    currentStock: payload.currentStock,
    minStock: payload.minStock,
    leadTimeDays: payload.leadTimeDays,
    supplier: payload.supplier || 'Not specified',
  });
  return product;
}

export async function updateProduct(user, productId, payload) {
  if (usingApi()) return api.updateProduct(user, productId, payload);
  await latency(500);
  const db = getDB(user);
  const existing = db.products.find((p) => p.id === productId);
  if (!existing) throw randomError('This product could not be found.');
  const patch = {};
  if (payload.name !== undefined) patch.name = payload.name;
  if (payload.category !== undefined) patch.category = payload.category;
  if (payload.description !== undefined) patch.description = payload.description;
  if (payload.supplier !== undefined) patch.supplier = payload.supplier;
  if (payload.unitCost !== undefined) patch.unitCost = Number(payload.unitCost);
  if (payload.sellingPrice !== undefined) patch.sellingPrice = Number(payload.sellingPrice);
  if (payload.currentStock !== undefined) patch.currentStock = Math.max(0, Number(payload.currentStock));
  if (payload.minStock !== undefined) patch.minStock = Number(payload.minStock);
  if (payload.leadTimeDays !== undefined) patch.leadTimeDays = Number(payload.leadTimeDays);
  return db.updateProduct(productId, patch);
}

export async function deleteProduct(user, productId) {
  if (usingApi()) return api.deleteProduct(user, productId);
  await latency(550);
  const db = getDB(user);
  db.deleteProduct(productId);
  return { ok: true };
}

// ------------------------------------------------------------------ CSV import

// The columns the canonical product contract accepts. `product_id`,
// `product_name` and `current_stock` are required; the rest are optional
// (category, lead_time_days, unit_price and safety_stock are what the inventory
// engine and the forecasting eligibility gate actually use). This constant
// mirrors the server-generated template in backend/contracts.py so the mock
// store and the api mode offer the same file.
export const PRODUCT_CSV_TEMPLATE = `product_id,product_name,category,current_stock,open_order_qty,expected_arrival_date,lead_time_days,unit_cost,safety_stock,reorder_point,unit_price,supplier,description,forecast_error_std
P001,Wireless Headphones,Electronics,225,0,2026-10-05,4,1000,20,60,1999,Acme Audio,Flagship wireless over-ear headset,6.2
P002,Desk Lamp,Home,190,50,2026-10-10,7,1800,15,40,899,Sunrise Supplies,Adjustable LED desk lamp,4.1`;

/**
 * Validate a CSV against the product catalog contract. Never silently accepts
 * invalid data: every erroneous row is reported so the user can inspect it
 * before importing. Throws on structurally broken files.
 */
export async function validateProductCsv(csvText, user) {
  if (usingApi()) return api.validateProductsCsv(csvText, user);
  const db = getDB(user);
  if (!csvText || !csvText.trim()) throw randomError('The uploaded file is empty.');

  const rows = parseCSV(csvText);
  if (rows.length === 0) throw randomError('The uploaded file is empty.');
  const header = rows[0].map((h) => h.trim().toLowerCase());

  const required = ['product_id', 'product_name', 'current_stock'];
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
  const seen = new Set();
  let totalRows = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    totalRows++;
    const lineNumber = i + 1;
    const productId = (row[idx.product_id] || '').trim();
    const productName = (row[idx.product_name] || '').trim();
    const currentStock = String(row[idx.current_stock] ?? '').trim();

    if (!productId) {
      errors.push({ row: lineNumber, reason: 'Missing product ID.' });
      continue;
    }
    if (seen.has(productId.toLowerCase())) {
      errors.push({ row: lineNumber, reason: `Duplicate product ID "${productId}" within the file.` });
      continue;
    }
    if (known.has(productId)) {
      errors.push({ row: lineNumber, reason: `Product ID "${productId}" already exists in your catalog.` });
      continue;
    }
    if (!productName) {
      errors.push({ row: lineNumber, reason: 'Missing product name.' });
      continue;
    }
    if (currentStock === '' || Number.isNaN(Number(currentStock)) || Number(currentStock) < 0) {
      errors.push({ row: lineNumber, reason: `Invalid current stock value "${currentStock}".` });
      continue;
    }
    if (!Number.isInteger(Number(currentStock))) {
      errors.push({ row: lineNumber, reason: `Current stock must be a whole number, got "${currentStock}".` });
      continue;
    }
    seen.add(productId.toLowerCase());
    valid.push({
      product_id: productId,
      product_name: productName,
      category: (row[idx.category] || '').trim() || 'Uncategorized',
      current_stock: Number(currentStock),
      lead_time_days: row[idx.lead_time_days] ? Number(row[idx.lead_time_days]) : undefined,
      unit_cost: row[idx.unit_cost] ? Number(row[idx.unit_cost]) : undefined,
      unit_price: row[idx.unit_price] ? Number(row[idx.unit_price]) : undefined,
      safety_stock: row[idx.safety_stock] ? Number(row[idx.safety_stock]) : undefined,
      supplier: (row[idx.supplier] || '').trim(),
      description: (row[idx.description] || '').trim(),
    });
  }

  return {
    ok: valid.length > 0,
    totalRows,
    validRows: valid.length,
    skippedRows: errors.length,
    errors,
    summary: {
      dups: errors.filter((e) => /duplicate/i.test(e.reason)).length,
      existing: errors.filter((e) => /already exists/i.test(e.reason)).length,
    },
    message:
      errors.length > 0
        ? `${errors.length} row${errors.length === 1 ? '' : 's'} failed validation. ${valid.length} row${valid.length === 1 ? '' : 's'} are ready to import.`
        : `${valid.length} row${valid.length === 1 ? '' : 's'} are ready to import.`,
    payload: valid,
  };
}

/**
 * Validate, then import the valid rows of a product CSV file.
 */
export async function uploadProductCsv(user, csvText) {
  if (usingApi()) return api.uploadProductsCsv(user, csvText);
  await latency(1000);
  const result = await validateProductCsv(csvText, user);
  if (result.validRows === 0) {
    throw randomError(result.errors.length ? 'CSV contains invalid rows. ' + result.errors[0].reason : 'CSV contains invalid rows.');
  }
  const db = getDB(user);
  db.importProductRows(result.payload);
  return {
    ...result,
    ok: true,
    message:
      result.errors.length > 0
        ? `${result.errors.length} row${result.errors.length === 1 ? ' was' : 's were'} skipped during validation. ${result.validRows} valid row${result.validRows === 1 ? ' was' : 's were'} imported.`
        : `${result.validRows} row${result.validRows === 1 ? '' : 's'} imported successfully.`,
  };
}

/** Download the product catalog CSV template. */
export async function downloadProductTemplateCsv(user) {
  if (usingApi()) {
    const text = await api.downloadProductTemplate(user);
    downloadFile('products-template.csv', text, 'text/csv');
    return;
  }
  downloadFile('products-template.csv', PRODUCT_CSV_TEMPLATE, 'text/csv');
}

export { getSuppliers };