// The product form's rules, the duplicate message, and the import counts.
//
// The bug these cover: the form accepted a product with no current stock, no
// minimum stock and no lead time, silently defaulting all three (0/0/7). The
// inventory engine then read "no units on hand" for a product the tenant had
// never counted, and every recommendation for it was wrong. The same rules run
// in the form and in the services, so these tests pin the shared source rather
// than one call site.

import { describe, expect, it } from 'vitest';
import {
  duplicateProductMessage,
  duplicateProductsMessage,
  productImportMessage,
  toCanonicalProductRow,
  validateProductInput,
} from './productFields';

const COMPLETE = {
  productId: 'P001',
  name: 'Wireless Headphones',
  category: 'Electronics',
  currentStock: '225',
  minStock: '20',
  leadTimeDays: '4',
  unitCost: '1000',
  sellingPrice: '1999',
  supplier: 'Acme Audio',
  description: 'Flagship headset',
};

describe('the fields a new product must answer', () => {
  it.each([
    ['currentStock', 'current stock (units on hand)'],
    ['minStock', 'minimum stock level'],
    ['leadTimeDays', 'lead time in days'],
  ])('refuses an empty %s and names it', (field, label) => {
    const problem = validateProductInput({ ...COMPLETE, [field]: '' });

    expect(problem).toBeTruthy();
    expect(problem).toContain(label);
  });

  it.each([
    ['currentStock', 'current stock (units on hand)'],
    ['minStock', 'minimum stock level'],
    ['leadTimeDays', 'lead time in days'],
  ])('refuses a missing %s the same way as an empty one', (field, label) => {
    const payload = { ...COMPLETE };
    delete payload[field];

    expect(validateProductInput(payload)).toContain(label);
  });

  it('accepts zero for all three, because zero is an answer', () => {
    const problem = validateProductInput({
      ...COMPLETE,
      currentStock: '0',
      minStock: '0',
      leadTimeDays: '0',
    });

    expect(problem).toBe('');
  });

  it('refuses a value that is not a number', () => {
    expect(validateProductInput({ ...COMPLETE, currentStock: 'twelve' })).toContain('current stock');
    expect(validateProductInput({ ...COMPLETE, minStock: '-4' })).toContain('minimum stock');
    expect(validateProductInput({ ...COMPLETE, leadTimeDays: '1e' })).toContain('lead time');
  });

  it('still refuses a missing name and a missing id', () => {
    expect(validateProductInput({ ...COMPLETE, name: '  ' })).toBe('Please enter a product name.');
    expect(validateProductInput({ ...COMPLETE, productId: '' })).toBe('Please enter a product ID.');
  });

  it('leaves supplier and description optional', () => {
    const problem = validateProductInput({
      ...COMPLETE,
      supplier: '',
      description: '',
    });

    expect(problem).toBe('');
  });

  it('leaves unit cost and selling price optional too', () => {
    // Counting stock is not the same as pricing it: a merchant who has just
    // walked the warehouse may not know either figure yet, and the answer then
    // is 0 rather than a refused form. Widening this to "required" would have
    // been a change nobody asked for.
    const problem = validateProductInput({
      ...COMPLETE,
      unitCost: '',
      sellingPrice: '',
    });

    expect(problem).toBe('');
    expect(toCanonicalProductRow({ ...COMPLETE, unitCost: '', sellingPrice: '' })).toMatchObject({
      unit_cost: 0,
      unit_price: 0,
    });
  });

  it('still refuses a price or cost that was typed as something other than a number', () => {
    // Blank is allowed; a typo is not, because it would be stored as 0 and
    // quietly rewrite the margin.
    expect(validateProductInput({ ...COMPLETE, unitCost: '1000rs' })).toContain('unit cost');
    expect(validateProductInput({ ...COMPLETE, sellingPrice: 'free' })).toContain('selling price');
    expect(validateProductInput({ ...COMPLETE, sellingPrice: '-1' })).toContain('selling price');
  });

  it('does not ask for a product id while an existing one is being edited', () => {
    const problem = validateProductInput({ ...COMPLETE, productId: '' }, { requireId: false });

    expect(problem).toBe('');
  });
});

describe('the canonical row a validated product sends', () => {
  it('writes a zero minimum stock rather than dropping it', () => {
    const row = toCanonicalProductRow({ ...COMPLETE, minStock: '0' });

    expect(row.safety_stock).toBe(0);
  });

  it('keeps supplier and description out when they are blank', () => {
    const row = toCanonicalProductRow({ ...COMPLETE, supplier: '  ', description: '' });

    expect(row).not.toHaveProperty('supplier');
    expect(row).not.toHaveProperty('description');
  });

  it('trims the identity fields', () => {
    const row = toCanonicalProductRow({ ...COMPLETE, productId: '  P001 ', name: ' Mouse ' });

    expect(row.product_id).toBe('P001');
    expect(row.product_name).toBe('Mouse');
  });
});

describe('the sentences a duplicate and an import report', () => {
  it('states the one thing to do about a taken product id', () => {
    expect(duplicateProductMessage('P001')).toBe(
      'Product ID P001 already exists in your catalog. Use a different Product ID or edit the existing product.',
    );
  });

  it('lists every id when a file brings several', () => {
    expect(duplicateProductsMessage(['P001', 'P002'])).toBe(
      'Product IDs P001, P002 already exist in your catalog. Use different Product IDs, or edit the existing products instead of re-creating them.',
    );
  });

  it('reports all three counts, including the zeroes', () => {
    expect(productImportMessage({ newProducts: 2, skipped: 1, failed: 0 })).toBe(
      'New products: 2 / Existing/skipped: 1 / Failed: 0.',
    );
    expect(productImportMessage({ newProducts: 0, skipped: 3, failed: 1 })).toBe(
      'New products: 0 / Existing/skipped: 3 / Failed: 1.',
    );
  });
});
