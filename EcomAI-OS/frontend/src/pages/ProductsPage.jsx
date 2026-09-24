import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Package, LayoutGrid, List } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import ProductCard from '../components/ProductCard';
import ProductForm from '../components/ProductForm';
import DataTable from '../components/DataTable';
import Pagination from '../components/ui/Pagination';
import EmptyState from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/Modal';
import { SearchInput, Select } from '../components/ui/form';
import { LoadingSkeleton } from '../components/ui/Skeleton';
import { StatusBadge } from '../components/ui/Badge';
import { listProducts } from '../services/inventoryService';
import { createProduct, updateProduct, deleteProduct } from '../services/productsService';
import { CATEGORIES } from '../services/mock/catalog';
import { useAuth } from '../context/AuthContext';
import { useData } from '../context/DataContext';
import { useToast } from '../context/ToastContext';
import { formatDate, cn } from '../lib/utils';

export default function ProductsPage() {
  const { user } = useAuth();
  const { refresh } = useData();
  const toast = useToast();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('grid');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listProducts(user, { search, category, sort: 'name', page, pageSize });
      setData(res);
    } catch {
      toast.error('Unable to load products. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, search, category, page, pageSize, toast]);

  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [search, category, pageSize]);

  const handleAdd = async (payload) => {
    setSubmitting(true);
    try {
      const created = await createProduct(user, payload);
      refresh();
      toast.success(`${created.name} was added to your catalog.`);
      setFormOpen(false);
    } catch (e) {
      throw e;
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (payload) => {
    setSubmitting(true);
    try {
      await updateProduct(user, editing.id, payload);
      refresh();
      toast.success(`${editing.name} was updated.`);
      setFormOpen(false);
      setEditing(null);
    } catch (e) {
      throw e;
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setDeleteLoading(true);
    try {
      await deleteProduct(user, deleting.id);
      refresh();
      toast.success(`${deleting.name} was removed.`);
      setDeleting(null);
    } catch {
      toast.error('Unable to delete the product. Please try again.');
    } finally {
      setDeleteLoading(false);
    }
  };

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (p) => {
    setEditing(p);
    setFormOpen(true);
  };

  const tableColumns = useMemo(
    () => [
      {
        key: 'product',
        label: 'Product',
        render: (p) => (
          <div>
            <p className="text-sm font-bold text-slate-800">{p.name}</p>
            <p className="font-mono text-[11px] text-slate-400">{p.id}</p>
          </div>
        ),
      },
      { key: 'category', label: 'Category', render: (p) => <span className="text-xs text-slate-500">{p.category}</span> },
      {
        key: 'stock',
        label: 'Current Stock',
        align: 'right',
        render: (p) => <span className="tnum text-sm font-bold text-slate-800">{p.currentStock}</span>,
      },
      { key: 'status', label: 'Status', render: (p) => <StatusBadge status={p.status} /> },
      {
        key: 'updated',
        label: 'Last Updated',
        render: (p) => <span className="text-xs text-slate-500">{formatDate(p.updatedAt)}</span>,
      },
      {
        key: 'actions',
        label: 'Actions',
        align: 'right',
        render: (p) => (
          <div className="flex justify-end gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => navigate(`/app/products/${p.id}`)}>
              View
            </Button>
            <Button variant="secondary" size="sm" onClick={() => openEdit(p)}>
              Edit
            </Button>
            <Button variant="danger-soft" size="sm" onClick={() => setDeleting(p)}>
              Delete
            </Button>
          </div>
        ),
      },
    ],
    [navigate],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Products"
        subtitle="Manage your product catalog and inventory information."
        actions={
          <Button icon={Plus} onClick={openAdd}>
            Add Product
          </Button>
        }
      />

      <Card bodyClassName="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search products" className="w-full sm:w-64" />
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full sm:w-44">
            <option value="all">All Categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <div className="ml-auto flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
            <button
              onClick={() => setView('grid')}
              className={cn('flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold', view === 'grid' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100')}
            >
              <LayoutGrid className="h-3.5 w-3.5" /> Grid
            </button>
            <button
              onClick={() => setView('table')}
              className={cn('flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold', view === 'table' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100')}
            >
              <List className="h-3.5 w-3.5" /> Table
            </button>
          </div>
        </div>
      </Card>

      {loading && !data ? (
        <LoadingSkeleton variant="cards" />
      ) : data?.items.length === 0 ? (
        <Card bodyClassName="p-0" pad={false}>
          <EmptyState
            icon={Package}
            title="No Products Yet"
            description="You haven’t added any products to your inventory."
            actionLabel="Add Your First Product"
            onAction={openAdd}
          />
        </Card>
      ) : view === 'grid' ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.items.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                onView={(prod) => navigate(`/app/products/${prod.id}`)}
                onEdit={openEdit}
                onDelete={setDeleting}
              />
            ))}
          </div>
          <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </>
      ) : (
        <Card bodyClassName="p-0" pad={false}>
          <DataTable
            columns={tableColumns}
            items={data.items}
            rowKey="id"
            onRowClick={(p) => navigate(`/app/products/${p.id}`)}
            emptyState={
              <EmptyState compact icon={Package} title="No products found" description="Try adjusting your search." />
            }
          />
          <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </Card>
      )}

      <ProductForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSubmit={editing ? handleEdit : handleAdd}
        initial={editing}
        submitting={submitting}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title={`Delete ${deleting?.name}?`}
        message="This removes the product and its sales history from your workspace. This action cannot be undone."
        confirmLabel="Delete Product"
        loading={deleteLoading}
      />
    </div>
  );
}