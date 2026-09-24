import React, { useState } from 'react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { Field, Input, Select, Textarea } from './ui/form';
import { getSuppliers } from '../services/productsService';
import { CATEGORIES } from '../services/mock/catalog';

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

  const handleSubmit = async () => {
    setError('');
    if (!form.name.trim()) return setError('Please enter a product name.');
    if (!form.productId.trim()) return setError('Please enter a product ID.');
    if (Number(form.unitCost) <= 0) return setError('Please enter a valid unit cost.');
    if (Number(form.sellingPrice) <= 0) return setError('Please enter a valid selling price.');
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
          <Field label="Product ID" required>
            <Input
              value={form.productId}
              onChange={set('productId')}
              placeholder="e.g. P101"
              disabled={editing}
            />
          </Field>
        )}

        <Field label="Product Name" required>
          <Input value={form.name} onChange={set('name')} placeholder="e.g. Wireless Mouse" />
        </Field>

        <div className={half}>
          <Field label="Category">
            <Select value={form.category} onChange={set('category')}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Supplier">
            <Input value={form.supplier} onChange={set('supplier')} placeholder="Supplier name" />
          </Field>
        </div>

        <Field label="Description">
          <Textarea
            value={form.description}
            onChange={set('description')}
            placeholder="Short description of the product (optional)"
          />
        </Field>

        <div className={half}>
          <Field label="Unit Cost (₹)">
            <Input type="number" min="0" value={form.unitCost} onChange={set('unitCost')} placeholder="0" />
          </Field>
          <Field label="Selling Price (₹)">
            <Input type="number" min="0" value={form.sellingPrice} onChange={set('sellingPrice')} placeholder="0" />
          </Field>
        </div>

        <div className={half}>
          <Field label="Current Stock">
            <Input type="number" min="0" value={form.currentStock} onChange={set('currentStock')} placeholder="0" />
          </Field>
          <Field label="Minimum Stock">
            <Input type="number" min="0" value={form.minStock} onChange={set('minStock')} placeholder="0" />
          </Field>
        </div>

        <Field label="Lead Time (days)" hint="Average days between placing an order and receiving stock.">
          <Input type="number" min="1" value={form.leadTimeDays} onChange={set('leadTimeDays')} placeholder="7" />
        </Field>
      </div>
    </Modal>
  );
}