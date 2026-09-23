import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import DashboardView from './views/DashboardView';
import InventoryTableView from './views/InventoryTableView';
import ForecastView from './views/ForecastView';
import SimulationView from './views/SimulationView';
import ProductsView from './views/ProductsView';
import SettingsView from './views/SettingsView';
import { fetchHealth, fetchProducts, fetchInventoryOverview } from './api/client';
import { CheckCircle2, AlertCircle } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [products, setProducts] = useState([]);
  const [selectedProductId, setSelectedProductId] = useState('P001');
  const [overviewData, setOverviewData] = useState(null);
  const [backendConnected, setBackendConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const loadData = async () => {
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
      console.error('Backend connection failed:', err);
      setBackendConnected(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleOrderPlaced = (qty) => {
    showToast(`Purchase order for ${qty} units created successfully!`, 'success');
    fetchInventoryOverview().then(setOverviewData).catch(console.error);
    fetchProducts().then(setProducts).catch(console.error);
  };

  const handleSaveSettings = () => {
    showToast('Business configuration updated successfully!', 'success');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased">
      {/* Top Header */}
      <Header
        alerts={overviewData?.alerts || []}
        onSelectProduct={setSelectedProductId}
        onNavigateTab={setActiveTab}
      />

      {/* Main Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Simple Sidebar */}
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          reorderCount={overviewData?.products_to_reorder || 0}
        />

        {/* Content Area */}
        <main className="flex-1 overflow-y-auto p-6 lg:p-8 bg-slate-950">
          <div className="max-w-6xl mx-auto">
            {!backendConnected && !loading && (
              <div className="mb-6 p-4 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>
                    Cannot reach FastAPI server at <code className="bg-rose-950 px-1 py-0.5 rounded">http://localhost:8000</code>.
                  </span>
                </div>
                <button
                  onClick={loadData}
                  className="px-3 py-1 bg-rose-500 hover:bg-rose-400 text-slate-950 rounded-lg font-bold"
                >
                  Retry
                </button>
              </div>
            )}

            {activeTab === 'dashboard' && (
              <DashboardView
                overviewData={overviewData}
                onSelectProduct={setSelectedProductId}
                onNavigateTab={setActiveTab}
              />
            )}

            {activeTab === 'inventory' && (
              <InventoryTableView
                products={products}
                selectedProductId={selectedProductId}
                onSelectProduct={setSelectedProductId}
                onOrderPlaced={handleOrderPlaced}
              />
            )}

            {activeTab === 'forecast' && (
              <ForecastView
                products={products}
                selectedProductId={selectedProductId}
                onSelectProduct={setSelectedProductId}
              />
            )}

            {activeTab === 'simulation' && (
              <SimulationView
                products={products}
                selectedProductId={selectedProductId}
                onSelectProduct={setSelectedProductId}
              />
            )}

            {activeTab === 'products' && (
              <ProductsView
                products={products}
                onSelectProduct={setSelectedProductId}
                onNavigateTab={setActiveTab}
              />
            )}

            {activeTab === 'settings' && (
              <SettingsView
                onSaveSettings={handleSaveSettings}
              />
            )}
          </div>
        </main>
      </div>

      {/* Floating Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs shadow-2xl shadow-emerald-500/20 animate-fadeIn">
          <CheckCircle2 className="w-4 h-4" />
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}
