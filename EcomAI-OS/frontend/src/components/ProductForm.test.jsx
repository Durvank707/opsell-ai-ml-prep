// The add/edit product form, and the three fields it used to let through blank.
//
// Current stock, minimum stock and lead time are what the inventory engine and
// the forecaster read. The form accepted all three empty and defaulted them
// (0 units, no floor, 7 days), so a product the tenant had never counted was
// stored as "no stock" and every recommendation for it was built on that. The
// form now refuses them with a sentence naming the field, and zero is still
// accepted, because no stock, no floor and same-day replenishment are real
// answers a catalog can be in.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProductForm from './ProductForm';

const CATEGORIES_IN_FORM = ['Electronics', 'Home', 'Fashion', 'Beauty', 'Sports', 'Toys', 'Books', 'Grocery'];

function field(label) {
  // The Field wrapper renders its label next to the control, so the input is
  // found by its accessible name rather than by a test id.
  return screen.getByLabelText(new RegExp(label, 'i'));
}

function fill(label, value) {
  fireEvent.change(field(label), { target: { value } });
}

function renderForm(props = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(<ProductForm open onClose={onSubmit} onSubmit={onSubmit} {...props} />);
  return { onSubmit: props.onSubmit || onSubmit, onClose };
}

beforeEach(() => {
  // Keep the test independent of the demo catalog's category list.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('adding a product', () => {
  it('refuses to submit while the three stock fields are empty, naming the first one', async () => {
    const { onSubmit } = renderForm();
    fill('Product ID', 'P101');
    fill('Product Name', 'Wireless Mouse');

    fireEvent.click(screen.getByRole('button', { name: /add product/i }));

    await waitFor(() =>
      expect(screen.getByText(/current stock \(units on hand\)/i)).toBeInTheDocument(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses an empty minimum stock even once the current stock is answered', async () => {
    const { onSubmit } = renderForm();
    fill('Product ID', 'P101');
    fill('Product Name', 'Wireless Mouse');
    fill('Current Stock', '40');

    fireEvent.click(screen.getByRole('button', { name: /add product/i }));

    await waitFor(() => expect(screen.getByText(/minimum stock level/i)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses an empty lead time, which the form itself had defaulted to 7', async () => {
    const { onSubmit } = renderForm();
    fill('Product ID', 'P101');
    fill('Product Name', 'Wireless Mouse');
    fill('Current Stock', '40');
    fill('Minimum Stock', '10');
    fill('Lead Time', '');

    fireEvent.click(screen.getByRole('button', { name: /add product/i }));

    await waitFor(() => expect(screen.getByText(/lead time in days/i)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('accepts zero for all three, because zero is an answer', async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    fill('Product ID', 'P101');
    fill('Product Name', 'Wireless Mouse');
    fill('Current Stock', '0');
    fill('Minimum Stock', '0');
    fill('Lead Time', '0');

    fireEvent.click(screen.getByRole('button', { name: /add product/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      productId: 'P101',
      name: 'Wireless Mouse',
      currentStock: '0',
      minStock: '0',
      leadTimeDays: '0',
    });
  });

  it('accepts a product with no supplier and no description', async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    fill('Product ID', 'P102');
    fill('Product Name', 'Desk Lamp');
    fill('Current Stock', '12');
    fill('Minimum Stock', '3');
    fill('Lead Time', '5');
    fill('Supplier', '');
    fill('Description', '');

    fireEvent.click(screen.getByRole('button', { name: /add product/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it('marks the three fields as required on the control, not only in the caption', () => {
    renderForm();

    // `required` on the input is what the browser and a screen reader act on;
    // the asterisk in the caption is only a visual cue. Zero stays allowed,
    // which is what `min="0"` is for.
    for (const label of ['Current Stock', 'Minimum Stock', 'Lead Time']) {
      expect(field(label)).toHaveAttribute('required');
      expect(field(label).getAttribute('min')).toBe('0');
    }
    expect(field('Unit Cost')).not.toHaveAttribute('required');
  });
});

describe('editing a product', () => {
  const existing = {
    id: 'P001',
    name: 'Wireless Headphones',
    category: CATEGORIES_IN_FORM[0],
    description: 'Flagship headset',
    unitCost: 1000,
    sellingPrice: 1999,
    currentStock: 225,
    minStock: 20,
    leadTimeDays: 4,
    supplier: 'Acme Audio',
  };

  it('does not ask for a product id, which is fixed once chosen', async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit, initial: existing });

    expect(screen.queryByLabelText(/product id/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].productId).toBe('P001');
  });

  it('prefills the three stock fields from the stored product', () => {
    renderForm({ initial: existing });

    expect(field('Current Stock').value).toBe('225');
    expect(field('Minimum Stock').value).toBe('20');
    expect(field('Lead Time').value).toBe('4');
  });
});
