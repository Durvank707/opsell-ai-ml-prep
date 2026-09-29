// The api-mode product CSV import, which is where the duplicate-product defect
// lived.
//
// The report used to be the server's alone, and the commit sent back every row
// the server had cleared. A catalog that already held P001 therefore had its
// P001 replaced by whatever the file said, silently: the name, supplier, price
// and stock stored under that id were overwritten and the tenant saw "imported"
// rather than "discarded a product you already had". The server now refuses such
// an id outright, and this path detects it before the commit as well, so the
// file adds what is new and says which products it left alone.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({
  fetchProducts: vi.fn(),
  postValidate: vi.fn(),
  postIngest: vi.fn(),
  fetchProduct: vi.fn(),
  fetchTemplate: vi.fn(),
  fetchInventoryOverview: vi.fn(),
  fetchReorder: vi.fn(),
  fetchProductForecast: vi.fn(),
  fetchTimeline: vi.fn(),
  patchProduct: vi.fn(),
  removeProduct: vi.fn(),
}));

vi.mock('./http', () => http);

// The data mode is a build-time setting and `requireApiSession` only asserts that
// an access token exists; neither is what these tests are about.
vi.mock('./mode', () => ({ requireApiSession: () => {} }));

const { uploadProductsCsv, validateProductsCsv } = await import('./catalog');

const USER = { id: 'tenant-a' };
const HEAD = 'product_id,product_name,current_stock,safety_stock,lead_time_days';

function csv(rows) {
  return [HEAD, ...rows].join('\n');
}

/** A server report that cleared every row, which is the starting point. */
function allAccepted(rowCount) {
  return {
    accepted_rows: rowCount,
    total_rows: rowCount,
    problems: [],
    schema_problems: [],
  };
}

function catalog(...productIds) {
  http.fetchProducts.mockResolvedValue({ products: productIds.map((product_id) => ({ product_id })) });
}

beforeEach(() => {
  Object.values(http).forEach((fn) => fn.mockReset());
  catalog('P001', 'P002');
  http.postIngest.mockResolvedValue({ ingested_rows: 1, persisted_to: 'supabase', durable: true });
});

describe('validating a product CSV that repeats products already in the catalog', () => {
  it('keeps the new row and reports the existing one instead of replacing it', async () => {
    http.postValidate.mockResolvedValue(allAccepted(2));

    const result = await validateProductsCsv(
      csv(['P001,Wireless Headphones,225,20,4', 'P050,Desk Lamp,12,3,5']),
      USER,
    );

    expect(result.payload.map((row) => row.product_id)).toEqual(['P050']);
    expect(result.existingProductIds).toEqual(['P001']);
    expect(result.summary.existing).toBe(1);
    expect(result.validRows).toBe(1);
    // All three counts, always: a tenant cannot otherwise tell that a file of
    // two rows only ever added one product.
    expect(result.message).toBe('New products: 1 / Existing/skipped: 1 / Failed: 0.');
  });

  it('names the existing product in the row error, in the same words as the form', async () => {
    http.postValidate.mockResolvedValue(allAccepted(2));

    const result = await validateProductsCsv(
      csv(['P001,Wireless Headphones,225,20,4', 'P050,Desk Lamp,12,3,5']),
      USER,
    );

    expect(result.errors).toEqual([
      {
        row: 1,
        reason:
          'Product ID P001 already exists in your catalog. Use a different Product ID or edit the existing product.',
        category: 'existing_product',
        severity: 'error',
      },
    ]);
  });

  it('treats a differently-cased id as the same product', async () => {
    // `p001` and `P001` are the same row in every table a merchant reads, so a
    // file that differs only in case is not a new product.
    http.postValidate.mockResolvedValue(allAccepted(1));

    const result = await validateProductsCsv(csv(['p001,Wireless Headphones,225,20,4']), USER);

    expect(result.payload).toEqual([]);
    expect(result.existingProductIds).toEqual(['p001']);
    expect(result.summary.existing).toBe(1);
  });

  it('reports the second of two identical ids in one file rather than importing both', async () => {
    http.postValidate.mockResolvedValue(allAccepted(2));

    const result = await validateProductsCsv(
      csv(['P050,Desk Lamp,12,3,5', 'P050,Desk Lamp v2,40,3,5']),
      USER,
    );

    expect(result.payload.map((row) => row.product_name)).toEqual(['Desk Lamp']);
    expect(result.errors[0]).toMatchObject({ row: 2, category: 'duplicate_in_file' });
    expect(result.message).toBe('New products: 1 / Existing/skipped: 0 / Failed: 1.');
  });

  it('still sends a row the server rejected for another reason only once', async () => {
    http.postValidate.mockResolvedValue({
      accepted_rows: 1,
      total_rows: 2,
      problems: [
        {
          row_number: 1,
          severity: 'error',
          category: 'missing_required',
          field: 'current_stock',
          detail: 'current_stock is required.',
        },
      ],
      schema_problems: [],
    });

    const result = await validateProductsCsv(
      csv(['P050,Desk Lamp,,3,5', 'P051,Monitor,4,1,3']),
      USER,
    );

    // The rejected line is not judged again here, and the accepted one is
    // carried through untouched.
    expect(result.payload.map((row) => row.product_id)).toEqual(['P051']);
    expect(result.errors.map((error) => error.category)).toEqual(['missing_required']);
  });
});

describe('committing a product CSV', () => {
  it('sends only the rows that are new', async () => {
    http.postValidate.mockResolvedValue(allAccepted(3));

    const result = await uploadProductsCsv(
      USER,
      csv([
        'P001,Wireless Headphones,225,20,4',
        'P050,Desk Lamp,12,3,5',
        'P002,Air Fryer,60,10,6',
      ]),
    );

    const commit = http.postIngest.mock.calls[0][1];
    expect(commit.recordType).toBe('product');
    expect(commit.rows.map((row) => row.product_id)).toEqual(['P050']);
    expect(result.newProducts).toBe(1);
    expect(result.skippedExisting).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('refuses the whole file, with no write, when every product already exists', async () => {
    http.postValidate.mockResolvedValue(allAccepted(2));

    await expect(
      uploadProductsCsv(
        USER,
        csv(['P001,Wireless Headphones,225,20,4', 'P002,Air Fryer,60,10,6']),
      ),
    ).rejects.toThrow(
      'No new products were imported. Product IDs P001, P002 already exist in your catalog. ' +
        'Use different Product IDs, or edit the existing products instead of re-creating them.',
    );
    expect(http.postIngest).not.toHaveBeenCalled();
  });

  it('propagates the server\'s refusal when a duplicate appears between the check and the commit', async () => {
    // The pre-flight check is not the only guard: the server refuses a duplicate
    // id outright, so a product created in another tab still cannot be replaced.
    http.postValidate.mockResolvedValue(allAccepted(1));
    http.postIngest.mockRejectedValue(
      new Error(
        'Product ID P050 already exists in your catalog. Use a different Product ID or edit the existing product.',
      ),
    );

    await expect(uploadProductsCsv(USER, csv(['P050,Desk Lamp,12,3,5']))).rejects.toThrow(
      /already exists in your catalog/,
    );
  });
});
