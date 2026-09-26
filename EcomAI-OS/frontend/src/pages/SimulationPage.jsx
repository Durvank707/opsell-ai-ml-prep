import React, { useCallback, useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Card from '../components/ui/Card';
import EmptyState from '../components/ui/EmptyState';
import SimulationConfig from '../components/SimulationConfig';
import SimulationResults from '../components/SimulationResults';
import { listProducts } from '../services/inventoryService';
import { getSalesData } from '../services/salesService';
import { runSimulation } from '../services/simulationService';
import { useAuth } from '../context/AuthContext';
import { useData } from '../context/DataContext';
import { useToast } from '../context/ToastContext';
import { LoadingSkeleton } from '../components/ui/Skeleton';

export default function SimulationPage() {
  const { user } = useAuth();
  const { refresh } = useData();
  const toast = useToast();

  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [lastConfig, setLastConfig] = useState(null);
  const [dataRange, setDataRange] = useState(null);
  const [rangeReady, setRangeReady] = useState(false);

  // The demand span the simulation form defaults to. Read alongside the product
  // list because a backtest replays recorded sales, so the period has to be one
  // this tenant actually recorded rows in.
  const loadRange = useCallback(async () => {
    try {
      const summary = await getSalesData(user);
      if (summary.dateFrom || summary.dateTo) {
        setDataRange({ from: summary.dateFrom, to: summary.dateTo });
      }
    } catch {
      // The form falls back to a calendar window, so a missing range is not
      // worth an error on a page whose subject is the simulation itself.
      setDataRange(null);
    } finally {
      setRangeReady(true);
    }
  }, [user]);

  const loadProducts = useCallback(async () => {
    setLoadingProducts(true);
    try {
      const res = await listProducts(user, { pageSize: 500 });
      setProducts(res.items);
    } catch {
      toast.error('Unable to load products for the simulation.');
    } finally {
      setLoadingProducts(false);
    }
  }, [user, toast]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    loadRange();
  }, [loadRange]);

  const handleRun = async (config) => {
    setRunning(true);
    setLastConfig(config);
    try {
      const result = await runSimulation(user, config);
      setResults(result);
      refresh();
    } catch (e) {
      toast.error(e.message || 'Unable to run the simulation. Please try again.');
    } finally {
      setRunning(false);
    }
  };

  // The form seeds its period from the loaded range, so the page waits for both
  // reads rather than mounting the form against defaults it would have to
  // discard a moment later.
  if (loadingProducts || !rangeReady) {
    return (
      <div className="space-y-5">
        <PageHeader title="Simulation" subtitle="Test inventory policies against historical demand." />
        <LoadingSkeleton rows={3} />
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader title="Simulation" subtitle="Test inventory policies against historical demand." />
        <Card className="py-16">
          <EmptyState
            icon={FlaskConical}
            title="Add products to simulate"
            description="Simulation evaluates your inventory policies against real demand history. Add products and sales data to get started."
            actionLabel="Add Products"
            onAction={() => window.location.assign('/app/products')}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Simulation"
        subtitle="Compare inventory policies and see the impact on service level, stockouts and cost."
      />

      <div className="grid gap-5 xl:grid-cols-5">
        <div className="xl:col-span-2">
          <div className="xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto xl:pr-1">
            <SimulationConfig
              products={products}
              dataRange={dataRange}
              onRun={handleRun}
              running={running}
              progressStep={running ? 'Evaluating demand, stockouts and costs across the selected period…' : ''}
            />
          </div>
        </div>

        <div className="xl:col-span-3">
          {results ? (
            <SimulationResults results={results} onRunAnother={() => setResults(null)} />
          ) : running ? (
            <Card className="flex flex-col items-center justify-center py-24 text-center">
              <span className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-brand-600" />
              <h3 className="mt-4 text-base font-bold text-slate-900">Running simulation…</h3>
              <p className="mt-1 max-w-sm text-sm text-slate-500">
                Replaying {lastConfig?.productSelection === 'all' ? 'all' : 'selected'} products against {lastConfig?.startDate} →{' '}
                {lastConfig?.endDate}. This usually takes a few seconds.
              </p>
            </Card>
          ) : (
            <Card className="flex flex-col items-center justify-center py-24 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
                <FlaskConical className="h-7 w-7" />
              </div>
              <h3 className="mt-4 text-base font-bold text-slate-900">Ready to simulate</h3>
              <p className="mt-1 max-w-sm text-sm text-slate-500">
                Configure an inventory policy on the left and run it against historical demand. Results compare current,
                conservative and aggressive policies automatically.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}