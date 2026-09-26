import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Database,
  UploadCloud,
  FileSpreadsheet,
  Calendar,
  Boxes,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  X,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import DataTable from '../components/DataTable';
import Pagination from '../components/ui/Pagination';
import EmptyState from '../components/ui/EmptyState';
import UploadDropzone from '../components/UploadDropzone';
import { SearchInput, Select, Field, Input } from '../components/ui/form';
import { LoadingSkeleton } from '../components/ui/Skeleton';
import { SimpleBars } from '../components/charts';
import {
  getSalesData,
  listSalesRecords,
  uploadSalesCsv,
  validateSalesCsv,
  downloadSampleCsv,
  loadSampleSalesData,
} from '../services/salesService';
import { useAuth } from '../context/AuthContext';
import { useData } from '../context/DataContext';
import { useToast } from '../context/ToastContext';
import { formatNumber, formatINR, formatDate, cn } from '../lib/utils';

const STEPS = [
  { key: 'choose', label: 'Choose File' },
  { key: 'upload', label: 'Upload' },
  { key: 'validate', label: 'Validate' },
  { key: 'import', label: 'Import' },
];

export default function SalesDataPage() {
  const { user } = useAuth();
  const { refresh } = useData();
  const toast = useToast();
  const navigate = useNavigate();

  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [loadKey, setLoadKey] = useState(0);

  // Records table state
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('all');
  const [channel, setChannel] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [records, setRecords] = useState(null);
  const [recordsLoading, setRecordsLoading] = useState(true);

  // Upload state
  const [fileName, setFileName] = useState('');
  const [fileText, setFileText] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | choosing | validating | ready | importing | done | error
  const [stepIndex, setStepIndex] = useState(0);
  const [validation, setValidation] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const data = await getSalesData(user);
      setSummary(data);
    } catch {
      toast.error('Unable to load sales summary. Please try again.');
    } finally {
      setSummaryLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary, loadKey]);

  const loadRecords = useCallback(async () => {
    setRecordsLoading(true);
    try {
      const res = await listSalesRecords(user, {
        search,
        productId,
        channel,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        page,
        pageSize,
      });
      setRecords(res);
    } catch {
      setRecords([]);
    } finally {
      setRecordsLoading(false);
    }
  }, [user, search, productId, channel, dateFrom, dateTo, page, pageSize]);

  useEffect(() => {
    const t = setTimeout(loadRecords, 120);
    return () => clearTimeout(t);
  }, [loadRecords]);

  useEffect(() => {
    setPage(1);
  }, [search, productId, channel, dateFrom, dateTo, pageSize]);

  // ------------------------------------------------------------ upload flow

  const handleFile = (text, name, err) => {
    if (err) {
      setUploadError(err.message);
      setPhase('error');
      setStepIndex(2);
      return;
    }
    if (!text) return;
    setFileName(name);
    setFileText(text);
    setUploadError('');
    setPhase('choosing');
    setStepIndex(1);
    toast.info('File ready — validating now.');
    setPhase('validating');
    setStepIndex(2);
    // In api mode validation is a server round trip, so the delay only exists
    // to keep the step indicator from flashing; it is a no-op in mock mode
    // where the store is in-memory.
    setTimeout(async () => {
      try {
        const result = await validateSalesCsv(text, user);
        setValidation(result);
        setPhase('ready');
        setStepIndex(2);
        if (result.skippedRows > 0) setShowErrors(true);
      } catch (e) {
        setUploadError(e.message || 'Unable to validate this file.');
        setPhase('error');
        setStepIndex(2);
      }
    }, 900);
  };

  const handleImport = async () => {
    setPhase('importing');
    setStepIndex(3);
    try {
      const result = await uploadSalesCsv(user, fileText);
      setValidation(result);
      setPhase('done');
      setStepIndex(4);
      refresh();
      setLoadKey((k) => k + 1);
      toast.success(result.message || 'Sales data imported successfully.');
    } catch (e) {
      setUploadError(e.message || 'Import failed. Please check the file and try again.');
      setPhase('error');
      toast.error(e.message || 'Import failed.');
    }
  };

  const resetUpload = () => {
    setFileName('');
    setFileText('');
    setPhase('idle');
    setStepIndex(0);
    setValidation(null);
    setShowErrors(false);
    setUploadError('');
  };

  const handleSampleImport = async () => {
    setPhase('importing');
    setStepIndex(4);
    try {
      const res = await loadSampleSalesData(user);
      refresh();
      setLoadKey((k) => k + 1);
      setValidation({
        totalRows: res.records,
        validRows: res.records,
        skippedRows: 0,
        errors: [],
        message: `${formatNumber(res.records)} historical records imported from the demo dataset.`,
      });
      setPhase('done');
    } catch (e) {
      setUploadError(e.message || 'Unable to import sample data.');
      setPhase('error');
    }
  };

  const columns = useMemo(
    () => [
      {
        key: 'product',
        label: 'Product',
        render: (r) => (
          <button
            onClick={() => navigate(`/app/products/${r.productId}`)}
            className="block text-left"
          >
            <p className="text-sm font-bold text-slate-800 hover:text-brand-700">{r.productName}</p>
            <p className="font-mono text-[11px] text-slate-400">{r.productId}</p>
          </button>
        ),
      },
      { key: 'date', label: 'Date', render: (r) => <span className="tnum text-sm text-slate-600">{formatDate(r.date)}</span> },
      { key: 'channel', label: 'Channel', render: (r) => <ChannelBadge channel={r.channel} /> },
      { key: 'units', label: 'Units Sold', align: 'right', render: (r) => <span className="tnum text-sm font-bold text-slate-800">{formatNumber(r.units)}</span> },
      { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => <span className="tnum text-sm text-slate-600">{formatINR(r.revenue)}</span> },
    ],
    [navigate],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sales Data"
        subtitle="Import, validate and explore your historical sales records."
        actions={
          <>
            <Button variant="secondary" icon={Sparkles} onClick={handleSampleImport}>
              Load Demo Data
            </Button>
            <Button icon={UploadCloud} onClick={() => setPhase('idle')}>
              Upload Sales Data
            </Button>
          </>
        }
      />

      {/* Summary */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryCard label="Total Records" value={summaryLoading ? '…' : formatNumber(summary?.totalRecords || 0)} icon={Database} tone="bg-brand-50 text-brand-600" />
        <SummaryCard label="Products Covered" value={summaryLoading ? '…' : formatNumber(summary?.productsCovered || 0)} icon={Boxes} tone="bg-emerald-50 text-emerald-600" />
        <SummaryCard label="Last Import" value={summaryLoading ? '…' : summary?.lastImport ? formatDate(summary.lastImport) : 'Never'} icon={RefreshCw} tone="bg-sky-50 text-sky-600" />
        <SummaryCard
          label="Date Range"
          value={
            summaryLoading
              ? '…'
              : summary?.dateFrom
                ? `${formatDate(summary.dateFrom, { month: 'short' })} – ${formatDate(summary.dateTo, { month: 'short' })}`
                : '—'
          }
          icon={Calendar}
          tone="bg-violet-50 text-violet-600"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Upload flow card */}
        <Card
          title="Upload Sales Data"
          subtitle="Add records from your sales channels"
          className="lg:col-span-2"
          actions={
            <div className="flex items-center gap-1">
              {STEPS.map((s, i) => (
                <React.Fragment key={s.key}>
                  <span
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold',
                      stepIndex > i || (phase === 'done' && i === 3)
                        ? 'bg-emerald-100 text-emerald-700'
                        : stepIndex === i && phase !== 'done'
                          ? 'bg-brand-600 text-white'
                          : 'bg-slate-100 text-slate-400',
                    )}
                  >
                    {stepIndex > i || (phase === 'done' && i === 3) ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
                  </span>
                  {i < STEPS.length - 1 && <span className="h-px w-4 bg-slate-200 sm:w-6" />}
                </React.Fragment>
              ))}
            </div>
          }
        >
          {phase === 'idle' ? (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <UploadDropzone onFile={handleFile} onDownloadSample={downloadSampleCsv} disabled={false} />
              <p className="max-w-md text-xs leading-relaxed text-slate-400">
                EcomAI-OS never accepts invalid data silently — every row is validated against your product catalog and
                errors are shown so you can fix and re-upload.
              </p>
            </div>
          ) : phase === 'validating' ? (
            <UploadPhase
              icon={AlertCircle}
              title={`Validating ${fileName}…`}
              subtitle="Checking dates, product IDs and units sold column by column."
              loading
            />
          ) : phase === 'importing' ? (
            <UploadPhase
              icon={UploadCloud}
              title="Importing your data…"
              subtitle="Adding valid rows to your sales history. This usually takes a few seconds."
              loading
            />
          ) : phase === 'done' && validation ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                <div>
                  <p className="text-sm font-bold text-slate-800">Import completed successfully</p>
                  <p className="mt-0.5 text-xs text-slate-600">{validation.message}</p>
                </div>
              </div>
              <ImportStats validation={validation} />
              {validation.skippedRows > 0 && (
                <ErrorsList validation={validation} showErrors={showErrors} setShowErrors={setShowErrors} />
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={resetUpload}>
                  Upload Another File
                </Button>
                <Button variant="ghost" onClick={() => navigate('/app/forecast')}>
                  View Forecast
                </Button>
              </div>
            </div>
          ) : phase === 'error' ? (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50/70 p-4">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
                <div>
                  <p className="text-sm font-bold text-slate-800">Import failed</p>
                  <p className="mt-0.5 text-xs text-slate-600">{uploadError}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={resetUpload}>
                  Choose a File
                </Button>
              </div>
            </div>
          ) : validation ? (
            <div className="space-y-4">
              <div
                className={cn(
                  'flex items-start gap-3 rounded-2xl border p-4',
                  validation.skippedRows > 0 ? 'border-amber-200 bg-amber-50/60' : 'border-emerald-200 bg-emerald-50/60',
                )}
              >
                {validation.skippedRows > 0 ? (
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                ) : (
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                )}
                <div>
                  <p className="text-sm font-bold text-slate-800">
                    {validation.skippedRows > 0 ? 'Validation completed with warnings' : 'Validation passed'}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-600">{validation.message}</p>
                </div>
              </div>

              <ImportStats validation={validation} />

              {validation.skippedRows > 0 && (
                <ErrorsList validation={validation} showErrors={showErrors} setShowErrors={setShowErrors} />
              )}

              <div className="flex flex-wrap gap-2">
                <Button onClick={handleImport} icon={UploadCloud}>
                  Start Import ({validation.validRows} rows)
                </Button>
                <Button variant="ghost" onClick={resetUpload}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </Card>

        {/* Channel breakdown */}
        <Card title="Sales by Channel" subtitle="Share of recorded orders">
          {summaryLoading || !summary ? (
            <LoadingSkeleton rows={4} />
          ) : summary.channels.length === 0 ? (
            <EmptyState compact icon={Database} title="No sales data yet" description="Upload records to see channel breakdown." />
          ) : (
            <>
              <SimpleBars data={summary.channels.map((c) => ({ name: c.name, value: c.count }))} height={200} />
              <div className="mt-3 space-y-1.5">
                {summary.channels.map((c) => (
                  <div key={c.name} className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">{c.name}</span>
                    <span className="tnum font-bold text-slate-700">{formatNumber(c.count)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Records table */}
      <Card
        title="Sales Records"
        subtitle="Recent validated sales transactions"
        bodyClassName="p-0"
        pad={false}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search products" className="w-full sm:w-56" />
          <Select value={channel} onChange={(e) => setChannel(e.target.value)} className="w-40">
            <option value="all">All Channels</option>
            <option>Online Store</option>
            <option>Amazon</option>
            <option>Flipkart</option>
            <option>Myntra</option>
            <option>Offline Store</option>
            <option>Import</option>
          </Select>
          <div className="flex items-center gap-2">
            <Field className="!mb-0">
              <Input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} className="w-40 py-1.5 text-xs" />
            </Field>
            <span className="text-xs text-slate-400">to</span>
            <Field className="!mb-0">
              <Input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} className="w-40 py-1.5 text-xs" />
            </Field>
          </div>
          {(search || channel !== 'all' || dateFrom || dateTo) && (
            <button
              onClick={() => {
                setSearch('');
                setChannel('all');
                setDateFrom('');
                setDateTo('');
              }}
              className="ml-auto flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700"
            >
              <X className="h-3.5 w-3.5" /> Clear filters
            </button>
          )}
        </div>
        <DataTable
          columns={columns}
          items={records?.items || []}
          rowKey="id"
          loading={recordsLoading}
          emptyState={
            <EmptyState
              compact
              icon={Database}
              title="No sales records found"
              description={
                records?.total === 0 && !summaryLoading && summary?.totalRecords === 0
                  ? 'Upload historical sales data to start forecasting demand.'
                  : 'Try adjusting your search or date filters.'
              }
              actionLabel={records?.total === 0 && summary?.totalRecords === 0 ? 'Upload Sales Data' : undefined}
              onAction={records?.total === 0 && summary?.totalRecords === 0 ? () => setPhase('idle') : undefined}
            />
          }
        />
        <Pagination page={page} pageSize={pageSize} total={records?.total || 0} onPageChange={setPage} onPageSizeChange={setPageSize} pageSizeOptions={[10, 25, 50, 100]} />
      </Card>
    </div>
  );
}

function SummaryCard({ label, value, icon: Icon, tone }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2.5">
        <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', tone)}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
      </div>
      <p className="tnum mt-3 text-xl font-extrabold text-slate-900">{value}</p>
    </div>
  );
}

function UploadPhase({ icon: Icon, title, subtitle, loading }) {
  return (
    <div className="flex flex-col items-center py-10 text-center">
      {loading ? (
        <span className="h-8 w-8 animate-spin rounded-full border-3 border-slate-200 border-t-brand-600" />
      ) : (
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <Icon className="h-5 w-5" />
        </span>
      )}
      <p className="mt-4 text-sm font-bold text-slate-800">{title}</p>
      <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
    </div>
  );
}

function ImportStats({ validation }) {
  const items = [
    { label: 'Total rows', value: formatNumber(validation.totalRows), tone: 'text-slate-800' },
    { label: 'Valid rows', value: formatNumber(validation.validRows), tone: 'text-emerald-700' },
    { label: 'Skipped rows', value: formatNumber(validation.skippedRows), tone: validation.skippedRows ? 'text-amber-700' : 'text-slate-400' },
  ];
  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map((i) => (
        <div key={i.label} className="rounded-xl bg-slate-50 p-3 text-center">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{i.label}</p>
          <p className={cn('tnum mt-1 text-lg font-extrabold', i.tone)}>{i.value}</p>
        </div>
      ))}
    </div>
  );
}

function ErrorsList({ validation, showErrors, setShowErrors }) {
  const visible = showErrors ? validation.errors : validation.errors.slice(0, 5);
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40">
      <div className="flex items-center justify-between border-b border-amber-200/60 px-4 py-2.5">
        <p className="flex items-center gap-1.5 text-xs font-bold text-amber-700">
          <FileSpreadsheet className="h-3.5 w-3.5" />
          {validation.errors.length} invalid {validation.errors.length === 1 ? 'row' : 'rows'}
        </p>
        <button onClick={() => setShowErrors((s) => !s)} className="text-[11px] font-semibold text-amber-600 hover:text-amber-800">
          {showErrors ? 'Show fewer' : `Show all (${validation.errors.length})`}
        </button>
      </div>
      <ul className="max-h-44 overflow-y-auto px-4 py-2">
        {visible.map((e, i) => (
          <li key={i} className="flex items-start gap-2 border-b border-amber-100 py-1.5 last:border-0">
            <span className="tnum shrink-0 font-mono text-[10px] font-bold text-amber-500">L{e.row}</span>
            <span className="text-xs text-slate-600">{e.reason}</span>
          </li>
        ))}
      </ul>
      <div className="px-4 py-2.5 pb-3">
        <p className="text-[11px] text-amber-700">
          Fix these rows in your file and re-upload. You can also download the template to match the expected format.
        </p>
      </div>
    </div>
  );
}

function ChannelBadge({ channel }) {
  const tones = {
    'Online Store': 'bg-brand-50 text-brand-700 border-brand-200',
    Amazon: 'bg-amber-50 text-amber-700 border-amber-200',
    Flipkart: 'bg-sky-50 text-sky-700 border-sky-200',
    Myntra: 'bg-violet-50 text-violet-700 border-violet-200',
    'Offline Store': 'bg-slate-100 text-slate-600 border-slate-200',
    Import: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  };
  // The canonical sales contract records no channel, so a row served by the API
  // genuinely has none. Say so rather than rendering an empty badge or
  // defaulting it to a channel the sale was never attributed to.
  if (!channel) {
    return (
      <span className="text-xs text-slate-400" title="The sales contract does not record a channel.">
        Not recorded
      </span>
    );
  }
  return (
    <span className={cn('inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold', tones[channel] || tones['Offline Store'])}>
      {channel}
    </span>
  );
}