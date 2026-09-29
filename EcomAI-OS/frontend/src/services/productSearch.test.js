// The comparison rules behind the Forecast page's product search.
//
// The page used to lowercase both sides of the comparison but kept the raw
// query, and it only ever searched the forecast rows. These tests pin the
// two things that were wrong: a query is normalized before it is compared, and
// the catalog — not the rows that happen to have a forecast — is what is
// searched.

import { describe, expect, it } from 'vitest';

import { matchesQuery, normalizeQuery, searchProducts } from './productSearch';

const BAND = { id: 'P006', name: 'Smart Fitness Band', category: 'Wearables' };
const MOUSE = { id: 'P007', name: 'Wireless Mouse', category: 'Electronics' };
const CHARGER = { id: 'P008', name: 'Wireless Charger', category: 'Accessories' };
const CATALOG = [BAND, MOUSE, CHARGER];

describe('normalizeQuery', () => {
  it('trims and case-folds a query', () => {
    expect(normalizeQuery('  Smart Fitness Band  ')).toBe('smart fitness band');
    expect(normalizeQuery('SMART FITNESS BAND')).toBe('smart fitness band');
  });

  it('treats a missing, blank or whitespace-only query as no query', () => {
    expect(normalizeQuery('')).toBe('');
    expect(normalizeQuery('   ')).toBe('');
    expect(normalizeQuery(null)).toBe('');
    expect(normalizeQuery(undefined)).toBe('');
  });
});

describe('matchesQuery', () => {
  it('finds the same product whatever case the name is typed in', () => {
    expect(matchesQuery('Smart Fitness Band', BAND)).toBe(true);
    expect(matchesQuery('smart fitness band', BAND)).toBe(true);
    expect(matchesQuery('SMART FITNESS BAND', BAND)).toBe(true);
    expect(matchesQuery('Smart fitness BAND', BAND)).toBe(true);
  });

  it('ignores surrounding whitespace in the query', () => {
    expect(matchesQuery('  smart fitness band ', BAND)).toBe(true);
    expect(matchesQuery('\tsmart fitness band\n', BAND)).toBe(true);
  });

  it('matches a part of the name, and the product id', () => {
    expect(matchesQuery('fitness', BAND)).toBe(true);
    expect(matchesQuery('band', BAND)).toBe(true);
    expect(matchesQuery('p006', BAND)).toBe(true);
    expect(matchesQuery('P006', BAND)).toBe(true);
  });

  it('does not match a product the query does not name', () => {
    expect(matchesQuery('wireless', BAND)).toBe(false);
    expect(matchesQuery('wireless', MOUSE)).toBe(true);
  });

  it('is false for a product that is not there, and true for an empty query', () => {
    expect(matchesQuery('band', null)).toBe(false);
    expect(matchesQuery('   ', BAND)).toBe(true);
  });
});

describe('searchProducts', () => {
  it('returns every catalog product matching the query, whatever the case', () => {
    expect(searchProducts(CATALOG, 'SMART FITNESS BAND')).toEqual([BAND]);
    expect(searchProducts(CATALOG, '  smart fitness band ')).toEqual([BAND]);
  });

  it('returns every match when several products match, in catalog order', () => {
    expect(searchProducts(CATALOG, 'wireless')).toEqual([MOUSE, CHARGER]);
    expect(searchProducts(CATALOG, 'WIRELESS')).toEqual([MOUSE, CHARGER]);
  });

  it('returns nothing for a query that matches no product', () => {
    expect(searchProducts(CATALOG, 'smartwatch')).toEqual([]);
  });

  it('treats an empty query as no search rather than the whole catalog', () => {
    expect(searchProducts(CATALOG, '')).toEqual([]);
    expect(searchProducts(CATALOG, '   ')).toEqual([]);
  });

  it('copes with a catalog that has not loaded', () => {
    expect(searchProducts(null, 'band')).toEqual([]);
  });
});
