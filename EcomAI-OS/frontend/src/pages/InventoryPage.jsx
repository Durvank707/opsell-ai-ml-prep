import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Boxes, Download, Plus, Eye } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import DataTable from '../components/DataTable';
import Pagination from '../components/ui/Pagination';
import { StatusBadge } from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { SearchInput, Select } from '../components/ui/form';
import { listProducts } from '../services/inventoryService';
import { CATEGORIES } from '../services/mock/catalog';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatNumber, cn } from '../lib/utils';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'healthy', label: 'Healthy' },
  { value: 'low', label: 'Low Stock' },
  { value: 'critical', label: 'Critical' },
  { value: 'overstocked', label: 'Overstocked' },
];

const SORTS = [
  { value: 'urgency', label: 'Reorder urgency' },
  { value: 'stock', label: 'Stock level' },
  { value: 'value', label: 'Inventory value' },
  { value: 'name', label: 'Product name' },
];

export default function InventoryPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState(searchParams.get('status') || 'all');
  const [sort, setSort] = useState('urgency');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listProducts(user, { search, category, status, sort, page, pageSize });
      setData(res);
    } catch {
      toast.error('Unable to load inventory. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user, search, category, status, sort, page, pageSize, toast]);

  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [search, category, status, sort, pageSize]);

  const recOrderHint = (p) => {
    const deficit = p.targetStock - p.inventoryPosition;
    return deficit > 0 ? Math.ceil((deficit || 20) / 5) * 5 : 20;
  };

  const columns = useMemo(
    () => [
      {
        key: 'product',
        label: 'Product',
        render: (p) => (
          <div>
            <p className="text-sm font-bold text-slate-800">{p.name}</p>
            <p className="font-mono text-[11px] text-slate-400">
              {p.id} · {p.sku}
            </p>
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
      {
        key: 'forecast30',
        label: '30-Day Forecast',
        align: 'right',
        render: (p) => (
          <span className="tnum text-sm text-slate-600">{p.forecast30 != null ? p.forecast30 : '—'}</span>
        ),
      },
      {
        key: 'rop',
        label: 'Reorder Point',
        align: 'right',
        render: (p) => <span className="tnum text-sm text-slate-500">{p.reorderPoint}</span>,
      },
      {
        key: 'safety',
        label: 'Safety Stock',
        align: 'right',
        render: (p) => <span className="tnum text-sm text-slate-500">{p.safetyStock}</span>,
      },
      {
        key: 'position',
        label: 'Inventory Position',
        align: 'right',
        render: (p) => (
          <span className="tnum text-sm text-slate-600">{p.inventoryPosition}</span>
        ),
      },
      {
        key: 'status',
        label: 'Status',
        render: (p) => <StatusBadge status={p.status} />,
      },
      {
        key: 'order',
        label: 'Recommended Order',
        align: 'right',
        render: (p) => {
          const qty = p.status === 'healthy' || p.status === 'overstocked' ? 0 : p.currentStock < p.reorderPoint ? recOrderHint(p) : 0;
          return qty > 0 ? (
            <span className="tnum text-xs font-bold text-brand-700">{qty} units</span>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          );
        },
      },
      {
        key: 'actions',
        label: 'Actions',
        align: 'right',
        render: (p) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/app/products/${p.id}`);
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            <Eye className="h-3 w-3" /> View
          </button>
        ),
      },
    ],
    [navigate],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inventory"
        subtitle="Monitor your stock levels and inventory health."
        actions={
          <>
            <Button variant="secondary" icon={Download} onClick={() => toast.info('Preparing your export…')}>
              Import Data
            </Button>
            <Button icon={Plus} onClick={() => navigate('/app/products')}>
              Add Product
            </Button>
          </>
        }
      />

      {/* Filters row */}
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
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full sm:w-40">
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-400">Sort</span>
            <Select value={sort} onChange={(e) => setSort(e.target.value)} className="w-full sm:w-44">
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          {data && (
            <span className="ml-auto flex items-center gap-1.5 text-xs font-semibold text-slate-500">
              <Boxes className="h-4 w-4 text-slate-400" />
              {data.total.toLocaleString('en-IN')} products
            </span>
          )}
        </div>
      </Card>

      {/* Table */}
      <Card bodyClassName="p-0" pad={false}>
        <DataTable
          columns={columns}
          items={data?.items || []}
          rowKey="id"
          loading={loading}
          onRowClick={(p) => navigate(`/app/products/${p.id}`)}
          emptyState={
            <EmptyState
              icon={Boxes}
              title="No products match your filters"
              description={
                data?.total === 0
                  ? 'You haven’t added any products to your inventory yet.'
                  : 'Try adjusting your search or filters.'
              }
              actionLabel={data?.total === 0 ? 'Add Your First Product' : undefined}
              onAction={data?.total === 0 ? () => navigate('/app/products') : undefined}
            />
          }
        />
        <Pagination
          page={page}
          pageSize={pageSize}
          total={data?.total || 0}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </Card>
    </div>
  );
}