// The two pieces of the import flow that report what happened to a file.
//
// The products flow is the reason these exist: a file that repeats a product the
// tenant already has used to be reported as N invalid rows, which is both wrong
// (nothing about the file needs fixing) and alarming (the upload card turns red
// over a correct import). A row naming an existing product is reported as
// skipped, and the counts say "added / already existed / failed" rather than
// "total / valid / skipped".

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorsList, ImportStats } from './importFlow';

function counts(text) {
  const cell = screen.getByText(text).closest('div');
  return cell.querySelector('p:last-child').textContent;
}

describe('the product import counts', () => {
  // A file of five rows: two added, two naming products the tenant already had,
  // and one the server refused outright.
  const validation = {
    validRows: 2,
    skippedRows: 3,
    summary: { existing: 2 },
    errors: [],
  };

  it('reports added, already existed and failed rather than total/valid/skipped', () => {
    render(<ImportStats validation={validation} variant="products" />);

    expect(screen.getByText('New products')).toBeInTheDocument();
    expect(screen.getByText('Already existed')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(counts('New products')).toBe('2');
    expect(counts('Already existed')).toBe('2');
    // Three rows were not imported, two of them existing products, so only the
    // third is a failure.
    expect(counts('Failed')).toBe('1');
  });

  it('still counts rows for the sales flow', () => {
    render(<ImportStats validation={{ totalRows: 10, validRows: 7, skippedRows: 3, errors: [] }} />);

    expect(counts('Total rows')).toBe('10');
    expect(counts('Valid rows')).toBe('7');
    expect(counts('Skipped rows')).toBe('3');
  });
});

describe('the rejected rows', () => {
  const validation = {
    errors: [
      {
        row: 1,
        category: 'existing_product',
        reason: 'Product ID P001 already exists in your catalog. Use a different Product ID or edit the existing product.',
      },
      { row: 4, category: 'missing_required', reason: 'Missing product name.' },
    ],
  };

  it('lists an existing product as skipped, not as an invalid row to fix', () => {
    render(<ErrorsList validation={validation} showErrors={false} setShowErrors={() => {}} />);

    expect(screen.getByText('1 product already in your catalog')).toBeInTheDocument();
    expect(screen.getByText('1 invalid row')).toBeInTheDocument();
    // The advice that cannot be followed ("fix these rows") belongs only to the
    // rows that really are the tenant's to fix.
    expect(screen.getByText(/Fix these rows in your file and re-upload/i)).toBeInTheDocument();
    expect(screen.getByText(/left exactly as they were/i)).toBeInTheDocument();
  });

  it('shows no invalid-rows box when every rejection is an existing product', () => {
    render(
      <ErrorsList
        validation={{ errors: [{ row: 2, category: 'existing_product', reason: 'Product ID P002 already exists in your catalog.' }] }}
        showErrors={false}
        setShowErrors={() => {}}
      />,
    );

    expect(screen.getByText('1 product already in your catalog')).toBeInTheDocument();
    expect(screen.queryByText(/invalid row/i)).toBeNull();
  });

  it('expands the invalid rows on request, and only the invalid ones', () => {
    const many = {
      errors: [
        { row: 1, category: 'existing_product', reason: 'Product ID P001 already exists in your catalog.' },
        ...Array.from({ length: 7 }, (_unused, index) => ({
          row: index + 2,
          category: 'invalid_value',
          reason: `Bad row ${index + 2}`,
        })),
      ],
    };
    let expanded = false;
    const setShowErrors = (next) => {
      expanded = typeof next === 'function' ? next(expanded) : next;
      rerender();
    };
    const { rerender: rawRerender } = render(
      <ErrorsList validation={many} showErrors={expanded} setShowErrors={setShowErrors} />,
    );
    const rerender = () =>
      rawRerender(<ErrorsList validation={many} showErrors={expanded} setShowErrors={setShowErrors} />);

    expect(screen.getAllByText(/Bad row/)).toHaveLength(5);
    fireEvent.click(screen.getByText('Show all (7)'));
    expect(screen.getAllByText(/Bad row/)).toHaveLength(7);
  });
});
