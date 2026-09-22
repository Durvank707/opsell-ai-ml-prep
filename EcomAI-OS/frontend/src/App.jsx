import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import OverviewView from './views/OverviewView';
import ForecastingView from './views/ForecastingView';
import InventoryView from './views/InventoryView';
import BacktestView from './views/BacktestView';
import { fetchHealth, fetchProducts, fetchInventoryOverview } from './api/client';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [products, setProducts] = useState([]);
  const [selectedProductId, setSelectedProductId] = useState('P001');
  const [overviewData, setOverviewData] = useState(null);
  const [backendConnected, setBackendConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const loadInitialData = async () => {
    try {
      setLoading(true);
      await fetchHealth();
      setBackendConnected(true);

      const [prods, overview] = await Promise.all([
        fetchProducts(),
        fetchInventoryOverview(),
      ]);

      setProducts(prods);
      setOverviewData(overview);
      if (prods.length > 0 && !selectedProductId) {
        setSelectedProductId(prods[0].product_id);
      }
    } catch (err) {
      console.error('Backend connection error:', err);
      setBackendConnected(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInitialData();
  }, []);

  const handleOrderPlaced = (qty) => {
    showToast(`Purchase order for ${qty} units successfully dispatched to supplier!`, 'success');
    // Refresh overview data
    fetchInventoryOverview().then(setOverviewData).catch(console.error);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased">
      {/* Top Navbar */}
      <Header
        products={products}
        selectedProductId={selectedProductId}
        onSelectProduct={setSelectedProductId}
        backendConnected={backendConnected}
        overviewData={overviewData}
      />

      {/* Main Layout Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          highRiskCount={overviewData?.high_risk_count || 0}
        />

        {/* Content View Container */}
        <main className="flex-1 overflow-y-auto p-6 lg:p-8 bg-slate-950">
          <div className="max-w-7xl mx-auto">
            {!backendConnected && !loading && (
              <div className="mb-6 p-4 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>
                    Cannot reach FastAPI backend at <code className="bg-rose-950 px-1 py-0.5 rounded">http://localhost:8000</code>. Ensure the server is running.
                  </span>
                </div>
                <button
                  onClick={loadInitialData}
                  className="px-3 py-1 bg-rose-500 hover:bg-rose-400 text-slate-950 rounded-lg font-bold"
                >
                  Retry Connection
                </button>
              </div>
            )}

            {activeTab === 'overview' && (
              <OverviewView
                overviewData={overviewData}
                onSelectProduct={setSelectedProductId}
                onNavigateTab={setActiveTab}
              />
            )}

            {activeTab === 'forecast' && (
              <ForecastingView
                products={products}
                selectedProductId={selectedProductId}
                onSelectProduct={setSelectedProductId}
              />
            )}

            {activeTab === 'inventory' && (
              <InventoryView
                products={products}
                selectedProductId={selectedProductId}
                onSelectProduct={setSelectedProductId}
                onOrderPlaced={handleOrderPlaced}
              />
            )}

            {activeTab === 'backtest' && (
              <BacktestView
                products={products}
                selectedProductId={selectedProductId}
                onSelectProduct={setSelectedProductId}
              />
            )}
          </div>
        </main>
      </div>

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs shadow-2xl shadow-emerald-500/20 animate-bounce">
          <CheckCircle2 className="w-4 h-4" />
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}
