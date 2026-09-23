import React, { useState } from 'react';
import { Search, Tag, IndianRupee, Layers, ChevronRight } from 'lucide-react';

export default function ProductsView({
  products = [],
  onSelectProduct,
  onNavigateTab,
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('ALL');

  const categories = ['ALL', ...new Set(products.map((p) => p.category))];

  const filtered = products.filter((p) => {
    const matchesSearch =
      p.product_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.product_name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCat = selectedCategory === 'ALL' || p.category === selectedCategory;
    return matchesSearch && matchesCat;
  });

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Products Catalog</h1>
        <p className="text-slate-400 text-sm mt-0.5">
          View all active SKUs, supplier costs, profit margins, and current stock positions.
        </p>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
          <input
            type="text"
            placeholder="Search by SKU or product name..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
        </div>

        {/* Categories */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                selectedCategory === cat
                  ? 'bg-emerald-500 text-slate-950 font-bold'
                  : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-950 text-slate-400 uppercase text-xs tracking-wider border-b border-slate-800 font-semibold">
              <tr>
                <th className="py-3.5 px-5">SKU & Name</th>
                <th className="py-3.5 px-4">Category</th>
                <th className="py-3.5 px-4 text-right">Selling Price</th>
                <th className="py-3.5 px-4 text-right">Unit Cost</th>
                <th className="py-3.5 px-4 text-right">Gross Margin</th>
                <th className="py-3.5 px-4 text-right">On-Hand Stock</th>
                <th className="py-3.5 px-4 text-center">Status</th>
                <th className="py-3.5 px-5 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 font-medium">
              {filtered.map((p) => {
                const margin = p.unit_price > 0
                  ? (((p.unit_price - p.unit_cost) / p.unit_price) * 100).toFixed(0)
                  : 0;

                return (
                  <tr key={p.product_id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-5">
                      <div className="font-bold text-white">{p.product_name}</div>
                      <div className="text-xs text-slate-500 font-mono">{p.product_id}</div>
                    </td>
                    <td className="py-3.5 px-4 text-slate-300 text-xs">{p.category}</td>
                    <td className="py-3.5 px-4 text-right font-mono text-white">
                      ₹{p.unit_price.toFixed(0)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono text-slate-400">
                      ₹{p.unit_cost.toFixed(0)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono text-emerald-400 font-bold">
                      {margin}%
                    </td>
                    <td className="py-3.5 px-4 text-right font-bold text-white font-mono">
                      {p.current_stock}
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-bold ${
                        p.decision === 'REORDER'
                          ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                          : p.decision === 'MONITOR'
                          ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                          : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                      }`}>
                        {p.decision_badge}
                      </span>
                    </td>
                    <td className="py-3.5 px-5 text-center">
                      <button
                        onClick={() => {
                          onSelectProduct(p.product_id);
                          onNavigateTab('inventory');
                        }}
                        className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 transition-colors inline-flex items-center gap-1"
                      >
                        <span>Inventory</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
