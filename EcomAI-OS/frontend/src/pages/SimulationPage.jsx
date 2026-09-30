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
import {
  SIMULATION_DISCLAIMER,
  SIMULATION_PURPOSE,
} from '../services/simulationPolicy';

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
        <PageHeader
          title="Simulation"
          subtitle={SIMULATION_PURPOSE}
        />
        <LoadingSkeleton rows={3} />
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Simulation"
          subtitle={SIMULATION_PURPOSE}
        />
        <Card className="py-16">
          <EmptyState
            icon={FlaskConical}
            title="Add products to simulate"
            description="Simulation replays real demand history to compare inventory strategies. Add products and sales data to get started."
            actionLabel="Add Products"
            onAction={() => window.location.assign('/app/products')}
          />
        </Card>
      </div>
    );
  }

  // The engine replays one product at a time, so the run reads as one product's
  // own history rather than a catalog-wide sweep it never performs.
  const runningProduct =
    products.find((p) => p.id === lastConfig?.productIds?.[0])?.name || 'the selected product';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Simulation"
        subtitle={SIMULATION_PURPOSE}
      />
      <p className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
        {SIMULATION_DISCLAIMER}
      </p>

      {/*
        One column, top to bottom: configure, then read. This used to be a
        five-column grid with the form pinned to the first two columns and the
        results in the other three. On a long run the results column grew well
        past the viewport, so the page scrolled while the form stayed pinned —
        leaving a tall empty column beside results the reader was still working
        through, and giving the timeline a third of the width it needs. Stacking
        them keeps both in the normal document flow.

        Both sections carry no width classes at all, which is what makes them
        align. An earlier version capped the form at `max-w-4xl` on the theory
        that a form reads better in a narrow measure; in practice it left the
        setup card visibly narrower than the results beneath it, so the page
        looked like two different documents stacked. Same container, same edges.
      */}
      <section aria-labelledby="simulation-setup-heading">
        <h2 id="simulation-setup-heading" className="sr-only">
          Configure simulation
        </h2>
        <SimulationConfig
          products={products}
          dataRange={dataRange}
          onRun={handleRun}
          running={running}
          progressStep={
            running ? 'Replaying demand, reorders and arrivals day by day…' : ''
          }
        />
      </section>

      <section aria-labelledby="simulation-results-heading">
        <h2 id="simulation-results-heading" className="sr-only">
          View results
        </h2>
        {results ? (
          <SimulationResults results={results} onRunAnother={() => setResults(null)} />
        ) : running ? (
          <Card className="flex flex-col items-center justify-center py-24 text-center">
            <span className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-brand-600" />
            <h3 className="mt-4 text-base font-bold text-slate-900">Running simulation…</h3>
            <p className="mt-1 max-w-sm text-sm text-slate-500">
              Replaying {runningProduct} against its own recorded demand, under each
              inventory strategy. This usually takes a few seconds.
            </p>
          </Card>
        ) : (
          <Card className="flex flex-col items-center justify-center py-24 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
              <FlaskConical className="h-7 w-7" />
            </div>
            <h3 className="mt-4 text-base font-bold text-slate-900">Ready to simulate</h3>
            <p className="mt-1 max-w-md text-sm text-slate-500">
              Choose a product above and replay its historical sales. One run compares
              how the standard inventory strategies would each have performed, and the
              results show every strategy side by side.
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}
