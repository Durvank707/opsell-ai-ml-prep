// The sales CSV rules in mock mode, which is what a tenant sees when the app
// runs without a backend (and what the component tests exercise).
//
// Two properties are pinned here:
//
//   a sales file naming a product the catalog does not have is refused whole,
//   with the ids and the fix, and writes nothing -- no product is invented, and
//   the other rows of the file are not quietly imported on their own;
//   an import prices a row by its own price, falling back to the catalog price,
//   rather than re-pricing every sale at today's list price.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store's simulated latency is 1.2s per call; these tests are about the
// rules, not the wait, and every other part of the store stays real.
vi.mock('./mock/db', async (importOriginal) => ({
  ...(await importOriginal()),
  latency: async () => {},
}));

const { getDB } = await import('./mock/db');
const { getSalesData, listSalesRecords, uploadSalesCsv, validateSalesCsv } = await import('./salesService');
const { unknownSalesProductsMessage } = await import('./importMessages');

const USER = { id: 'test-user', email: 'test@example.com' };
const HEADER = 'date,product_id,units_sold,price,category,promotion,channel';

function csv(rows) {
  return [HEADER, ...rows].join('\n');
}

/** A catalog with one product and an *empty* series for it.

 * The store synthesises a year of history for any product it has not stored
 * sales for, which is right for a demo tenant and fatal for a test: the
 * fixtures here must read back only the rows the test imported.
 */
function seedCatalog({ id = 'P001', sellingPrice = 500 } = {}) {
  const db = getDB(USER);
  db.products = [];
  db.salesByProduct = new Map();
  db.salesMeta = { totalRecords: 0, lastImport: null, dateFrom: null, dateTo: null };
  db.products.push({
    id,
    sku: id,
    name: 'Wireless Headphones',
    category: 'Electronics',
    sellingPrice,
    currentStock: 10,
    minStock: 2,
    leadTimeDays: 4,
  });
  db.salesByProduct.set(id, []);
  return db;
}

beforeEach(() => {
  getDB(USER).products = [];
  getDB(USER).salesByProduct = new Map();
});

describe('a sales file naming products this tenant has not added', () => {
  it('is refused, naming every id and the fix', async () => {
    seedCatalog();

    const file = csv([
      '2026-09-01,P001,5,799,Electronics,false,Online Store',
      '2026-09-01,P999,3,100,Electronics,false,Online Store',
      '2026-09-01,P1000,2,100,Electronics,false,Online Store',
      '2026-09-01,P1001,1,100,Electronics,false,Online Store',
    ]);

    await expect(uploadSalesCsv(USER, file)).rejects.toThrow(
      'Sales import contains 3 product IDs that are not in your catalog: P999, P1000, P1001. ' +
        'Add these products to your catalog first, then upload the sales data.',
    );
  });

  it('writes nothing: not the known rows, and not the unknown products', async () => {
    const db = seedCatalog();

    const file = csv([
      '2026-09-01,P001,5,799,Electronics,false,Online Store',
      '2026-09-01,P999,3,100,Electronics,false,Online Store',
    ]);

    await expect(uploadSalesCsv(USER, file)).rejects.toThrow(/not in your catalog/);

    expect(db.products.map((product) => product.id)).toEqual(['P001']);
    expect(db.salesByProduct.get('P001')).toEqual([]);
  });

  it('refuses the whole file rather than importing the rows it does understand', async () => {
    seedCatalog();

    const file = csv([
      '2026-09-01,P001,5,799,Electronics,false,Online Store',
      '2026-09-01,P404,3,100,Electronics,false,Online Store',
    ]);

    const report = await validateSalesCsv(file, USER);

    expect(report.ok).toBe(false);
    expect(report.validRows).toBe(0);
    expect(report.payload).toEqual([]);
    expect(report.unknownProductIds).toEqual(['P404']);
    expect(report.message).toBe(unknownSalesProductsMessage(['P404']));
  });

  it('still imports a file whose every product is known', async () => {
    const db = seedCatalog();

    const result = await uploadSalesCsv(
      USER,
      csv([
        '2026-09-01,P001,5,799,Electronics,false,Online Store',
        '2026-09-02,P001,2,799,Electronics,false,Online Store',
      ]),
    );

    expect(result.validRows).toBe(2);
    expect(db.salesByProduct.get('P001')).toHaveLength(2);
  });
});

describe('the sentence a refused sales file carries', () => {
  it('reads one unknown id as a single product', () => {
    expect(unknownSalesProductsMessage(['P404'])).toBe(
      'Sales import contains 1 product ID that is not in your catalog: P404. ' +
        'Add this product to your catalog first, then upload the sales data.',
    );
  });

  it('summarises a long list instead of pasting a whole column', () => {
    const message = unknownSalesProductsMessage(
      Array.from({ length: 25 }, (_unused, index) => `P${String(index + 1).padStart(3, '0')}`),
    );

    expect(message).toContain('Sales import contains 25 product IDs');
    expect(message).toContain('and 15 more');
  });
});

describe('pricing an imported sale', () => {
  it('uses the price the row stated, not the catalog price', async () => {
    seedCatalog({ sellingPrice: 500 });

    await uploadSalesCsv(USER, csv(['2026-09-01,P001,5,799,Electronics,false,Online Store']));

    const { items } = await listSalesRecords(USER);
    expect(items[0].price).toBe(799);
    expect(items[0].revenue).toBe(3995);
  });

  it('falls back to the catalog price when the row stated none', async () => {
    seedCatalog({ sellingPrice: 500 });

    await uploadSalesCsv(USER, csv(['2026-09-01,P001,5,,,,,']));

    const { items } = await listSalesRecords(USER);
    expect(items[0].price).toBe(500);
    expect(items[0].revenue).toBe(2500);
  });

  it('reports an unpriceable sale as absent rather than as a zero', async () => {
    seedCatalog({ sellingPrice: 0 });

    await uploadSalesCsv(USER, csv(['2026-09-01,P001,5,,,,,']));

    const { items } = await listSalesRecords(USER);
    expect(items[0].revenue).toBeNull();

    const summary = await getSalesData(USER);
    expect(summary.totalRecords).toBe(1);
    expect(summary.totalRevenue).toBe(0);
    // The units are counted and the missing price is disclosed, not hidden.
    expect(summary.totalUnits).toBe(5);
    expect(summary.pricedRecords).toBe(0);
  });
});
