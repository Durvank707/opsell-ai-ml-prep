// Products service — create / update / delete operations.

import { getDB, latency, randomError } from './mock/db';
import { getSuppliers } from './mock/catalog';
import { usingApi } from './api/mode';
import * as api from './api/catalog';

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

export { getSuppliers };