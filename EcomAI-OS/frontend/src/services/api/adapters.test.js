// How the browser prices a sales record.
//
// The bug: `toSalesRecord` read only the row's own `price`, so a sale that
// recorded no price became `revenue: null`, and `formatINR(null)` rendered that
// as "₹0" — a table claiming a sale was worth nothing, and a summary that
// under-reported the tenant's revenue by whatever those units were sold for.

import { describe, expect, it } from 'vitest';
import { toSalesRecord, toSalesSummary } from './adapters';

describe('the revenue one sales record is worth', () => {
  it('multiplies units by the price the row stated', () => {
    // 5 units at 799.
    const record = toSalesRecord({
      product_id: 'P001',
      date: '2026-09-01',
      units_sold: 5,
      price: 799,
      channel: 'Online Store',
    });

    expect(record.revenue).toBe(3995);
    expect(record.price).toBe(799);
  });

  it('falls back to the effective unit price the server resolved', () => {
    const record = toSalesRecord({
      product_id: 'P001',
      date: '2026-09-01',
      units_sold: 5,
      price: null,
      unit_price: 799,
      channel: 'Online Store',
    });

    expect(record.revenue).toBe(3995);
    expect(record.price).toBe(799);
  });

  it('prefers the row price over the catalog fallback', () => {
    const record = toSalesRecord({
      product_id: 'P001',
      date: '2026-09-01',
      units_sold: 2,
      price: 250,
      unit_price: 799,
      channel: 'Online Store',
    });

    expect(record.revenue).toBe(500);
  });

  it('reports an unknown revenue as absent rather than as zero', () => {
    const record = toSalesRecord({
      product_id: 'P001',
      date: '2026-09-01',
      units_sold: 5,
      price: null,
      unit_price: null,
      channel: 'Online Store',
    });

    expect(record.revenue).toBeNull();
    expect(record.units).toBe(5);
  });

  it('prices a zero-unit record at zero, which is a real figure', () => {
    const record = toSalesRecord({
      product_id: 'P001',
      date: '2026-09-01',
      units_sold: 0,
      price: 799,
      channel: 'Online Store',
    });

    expect(record.revenue).toBe(0);
  });

  it('rounds to paise, so a fractional price does not leak binary noise', () => {
    const record = toSalesRecord({
      product_id: 'P001',
      date: '2026-09-01',
      units_sold: 3,
      price: 19.995,
      channel: 'Online Store',
    });

    expect(record.revenue).toBe(59.99);
  });

  it('keeps the product id in the row key even without a price', () => {
    const record = toSalesRecord({
      product_id: 'P001',
      date: '2026-09-01',
      units_sold: 1,
    });

    expect(record.id).toBe('P001-2026-09-01-unrecorded');
    expect(record.unrecordedChannel).toBe(true);
  });
});

describe('the sales summary', () => {
  it('passes through the priced-record count the server reports', () => {
    const summary = toSalesSummary({
      total_records: 3,
      total_units: 10,
      total_revenue: 3995,
      priced_records: 2,
    });

    expect(summary.totalRevenue).toBe(3995);
    expect(summary.pricedRecords).toBe(2);
  });

  it('leaves the count absent when the server does not report one', () => {
    expect(toSalesSummary({ total_records: 1 }).pricedRecords).toBeNull();
  });
});
