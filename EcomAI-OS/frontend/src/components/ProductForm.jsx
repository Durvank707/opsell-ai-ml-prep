import React, { useState } from 'react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { Field, Input, Select, Textarea } from './ui/form';
import { getSuppliers } from '../services/productsService';
import { CATEGORIES } from '../services/mock/catalog';
import { validateProductInput } from '../services/productFields';

const SUPPLIERS = getSuppliers();

export default function ProductForm({ open, onClose, onSubmit, initial = null, submitting = false }) {
  const editing = Boolean(initial);
  const [error, setError] = useState('');
  const [form, setForm] = useState(() =>
    initial
      ? {
          productId: initial.id,
          name: initial.name,
          category: initial.category,
          description: initial.description || '',
          unitCost: initial.unitCost,
          sellingPrice: initial.sellingPrice,
          currentStock: initial.currentStock,
          minStock: initial.minStock || initial.reorderPoint || 0,
          leadTimeDays: initial.leadTimeDays,
          supplier: initial.supplier || SUPPLIERS[0],
        }
      : {
          productId: '',
          name: '',
          category: 'Electronics',
          description: '',
          unitCost: '',
          sellingPrice: '',
          currentStock: '',
          minStock: '',
          leadTimeDays: 7,
          supplier: SUPPLIERS[0],
        },
  );

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // The same rules the services apply, so the form refuses exactly what the
  // write would refuse and says it in the same words. `requireId` is off while
  // editing: an existing product's ID is fixed and is not part of the patch.
  const handleSubmit = async () => {
    setError('');
    const problem = validateProductInput(form, { requireId: !editing });
    if (problem) return setError(problem);
    try {
      await onSubmit(form);
      onClose();
    } catch (e) {
      setError(e.message || 'Something went wrong. Please try again.');
    }
  };

  const half = 'grid grid-cols-2 gap-3';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${initial?.name}` : 'Add Product'}
      description={
        editing
          ? 'Update product and inventory details.'
          : 'Add a product to your catalog to start tracking inventory.'
      }
      width="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={submitting}>
            {editing ? 'Save Changes' : 'Add Product'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
            {error}
          </div>
        )}

        {!editing && (
          <Field label="Product ID" required htmlFor="product-id">
            <Input
              id="product-id"
              value={form.productId}
              onChange={set('productId')}
              placeholder="e.g. P101"
              disabled={editing}
            />
          </Field>
        )}

        <Field label="Product Name" required htmlFor="product-name">
          <Input
            id="product-name"
            value={form.name}
            onChange={set('name')}
            placeholder="e.g. Wireless Mouse"
          />
        </Field>

        <div className={half}>
          <Field label="Category" htmlFor="product-category">
            <Select id="product-category" value={form.category} onChange={set('category')}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Supplier" htmlFor="product-supplier">
            <Input
              id="product-supplier"
              value={form.supplier}
              onChange={set('supplier')}
              placeholder="Supplier name"
            />
          </Field>
        </div>

        <Field label="Description" htmlFor="product-description">
          <Textarea
            id="product-description"
            value={form.description}
            onChange={set('description')}
            placeholder="Short description of the product (optional)"
          />
        </Field>

        <div className={half}>
          <Field label="Unit Cost (₹)" htmlFor="product-unit-cost">
            <Input
              id="product-unit-cost"
              type="number"
              min="0"
              value={form.unitCost}
              onChange={set('unitCost')}
              placeholder="0"
            />
          </Field>
          <Field label="Selling Price (₹)" htmlFor="product-selling-price">
            <Input
              id="product-selling-price"
              type="number"
              min="0"
              value={form.sellingPrice}
              onChange={set('sellingPrice')}
              placeholder="0"
            />
          </Field>
        </div>

        {/* Current stock, minimum stock and lead time are required, and `min="0"`
            because zero is a real answer for all three: no units on hand, no
            reorder floor, and same-day replenishment are states a catalog can
            legitimately be in. Only an empty or non-numeric value is refused.
            The attribute is on the control as well as on the caption, so the
            browser and a screen reader both know these are not optional. */}
        <div className={half}>
          <Field label="Current Stock" required htmlFor="product-current-stock">
            <Input
              id="product-current-stock"
              type="number"
              min="0"
              required
              value={form.currentStock}
              onChange={set('currentStock')}
              placeholder="0"
            />
          </Field>
          <Field label="Minimum Stock" required htmlFor="product-min-stock">
            <Input
              id="product-min-stock"
              type="number"
              min="0"
              required
              value={form.minStock}
              onChange={set('minStock')}
              placeholder="0"
            />
          </Field>
        </div>

        <Field
          label="Lead Time (days)"
          required
          htmlFor="product-lead-time"
          hint="Average days between placing an order and receiving stock."
        >
          <Input
            id="product-lead-time"
            type="number"
            min="0"
            required
            value={form.leadTimeDays}
            onChange={set('leadTimeDays')}
            placeholder="7"
          />
        </Field>
      </div>
    </Modal>
  );
}