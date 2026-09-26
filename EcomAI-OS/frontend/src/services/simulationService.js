// Inventory simulation (V2) — evaluates inventory policies against historical demand.
//
// In `mock` mode the policies are replayed in the browser against the
// deterministic store. In `api` mode the same call is a real backtest on the
// server, run through the shared simulation engine over this tenant's own sales
// history and this tenant's own error spread.

import { getDB, latency, randomError } from './mock/db';
import { hashString, mulberry32 } from '../lib/utils';
import { usingApi } from './api/mode';
import * as api from './api/intelligence';

export const POLICY_PRESETS = [
  { key: 'current', label: 'Current Policy', safetyMultiplier: 1, reorderMultiplier: 1, orderMultiplier: 1 },
  { key: 'conservative', label: 'Conservative Policy', safetyMultiplier: 1.5, reorderMultiplier: 1.15, orderMultiplier: 1.25 },
  { key: 'aggressive', label: 'Aggressive Policy', safetyMultiplier: 0.5, reorderMultiplier: 0.8, orderMultiplier: 0.9 },
];

const WEEKDAY_FACTOR = [0.8, 0.9, 0.95, 1.0, 1.08, 1.3, 1.18];

function demandForDay(db, p, dateStr) {
  const series = db.getSales(p.id);
  const exact = series.find((s) => s.date === dateStr);
  if (exact) return exact.units;
  // Beyond history — projected demand.
  const d = new Date(dateStr);
  return Math.max(0, Math.round(p.dailyAvg * WEEKDAY_FACTOR[d.getDay()] * (1 + p.sigma / Math.max(p.dailyAvg, 1) * 0)));
}

function simulateProduct(db, p, { start, end, safety, reorderPoint, targetOrderQty, pack }) {
  const dates = [];
  const endDate = new Date(end);
  for (let d = new Date(start); d <= endDate; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }

  let stock = p.currentStock;
  const arrivals = []; // {date, qty}
  let stockoutEvents = 0;
  let stockoutUnits = 0;
  let excessUnits = 0;
  let orders = 0;
  let holding = 0;
  let inStockDays = 0;

  for (const ds of dates) {
    // incoming shipment
    const idx = arrivals.findIndex((a) => a.date === ds);
    if (idx >= 0) {
      stock += arrivals[idx].qty;
      arrivals.splice(idx, 1);
    }
    const demand = demandForDay(db, p, ds);
    const fulfilled = Math.min(demand, stock);
    stock -= fulfilled;
    if (fulfilled < demand) {
      stockoutUnits += demand - fulfilled;
      stockoutEvents++;
    } else {
      inStockDays++;
    }

    const effectiveRop = Math.round(reorderPoint * p.dailyAvg + p.dailyAvg * p.leadTimeDays);
    const target = Math.round(targetOrderQty);
    if (stock <= effectiveRop && arrivals.length === 0) {
      const deficit = target - (stock + arrivals.reduce((s, a) => s + a.qty, 0));
      if (deficit > 0) {
        const qty = Math.max(pack, Math.ceil(deficit / pack) * pack);
        const arrival = new Date(ds);
        arrival.setDate(arrival.getDate() + p.leadTimeDays);
        arrivals.push({ date: arrival.toISOString().slice(0, 10), qty });
        orders++;
      }
    }

    if (stock > target * 1.1) excessUnits += stock - target;
    // daily holding cost (₹) — approximated from average stock during the day
    holding += Math.max(0, stock) * p.unitCost * 0.2 / 365;
  }

  return {
    productId: p.id,
    name: p.name,
    category: p.category,
    stockoutEvents,
    stockoutUnits,
    excessUnits,
    orders,
    holding,
    serviceDays: inStockDays,
    totalDays: dates.length,
    unitCost: p.unitCost,
  };
}

const cache = new Map(); // configHash -> result

function runPolicy(db, productIds, config, policy) {
  const { start, end, pack, safety, reorder, orderQty } = config;
  const perProduct = productIds.map((id) => {
    const p = db.products.find((x) => x.id === id);
    if (!p) throw randomError('A selected product no longer exists.');
    return simulateProduct(db, p, {
      start,
      end,
      safety: safety * policy.safetyMultiplier,
      reorderPoint: reorder * policy.reorderMultiplier,
      targetOrderQty: orderQty * policy.orderMultiplier,
      pack,
    });
  });

  const totalDemandDays = perProduct.reduce((s, r) => s + r.totalDays, 0);
  const totalServiceDays = perProduct.reduce((s, r) => s + r.serviceDays, 0);
  const totalStockoutUnits = perProduct.reduce((s, r) => s + r.stockoutUnits, 0);
  const totalStockoutEvents = perProduct.reduce((s, r) => s + r.stockoutEvents, 0);
  const totalExcess = perProduct.reduce((s, r) => s + r.excessUnits, 0);
  const totalOrders = perProduct.reduce((s, r) => s + r.orders, 0);
  const holding = perProduct.reduce((s, r) => s + r.holding, 0);

  const orderingCost = totalOrders * config.orderingCostPerOrder;
  const stockoutCost = totalStockoutUnits * config.stockoutCostPerUnit;
  const totalCost = holding + orderingCost + stockoutCost;
  const serviceLevel = totalDemandDays
    ? Math.round((totalServiceDays / totalDemandDays) * 1000) / 10
    : 0;

  const affected = perProduct
    .filter((r) => r.stockoutUnits > 0)
    .sort((a, b) => b.stockoutUnits - a.stockoutUnits)
    .slice(0, 8);
  const avgDuration = affected.length
    ? Math.round((affected.reduce((s, r) => s + r.stockoutEvents, 0) / affected.length) * 10) / 10
    : 0;

  const excessProducts = perProduct
    .filter((r) => r.excessUnits > 0)
    .sort((a, b) => b.excessUnits - a.excessUnits)
    .slice(0, 8);
  const avgExcess = excessProducts.length
    ? Math.round(excessProducts.reduce((s, r) => s + r.excessUnits, 0) / excessProducts.length)
    : 0;

  return {
    kpis: {
      serviceLevel,
      stockoutEvents: totalStockoutEvents,
      stockoutUnits: totalStockoutUnits,
      excessInventory: Math.round(totalExcess),
      inventoryCost: Math.round(totalCost),
      totalOrders,
      holdingCost: Math.round(holding),
      orderingCost: Math.round(orderingCost),
      stockoutCost: Math.round(stockoutCost),
      stockoutsAvoidedDemandUnits: totalStockoutUnits,
    },
    stockout: {
      events: totalStockoutEvents,
      productsAffected: affected,
      totalLostUnits: totalStockoutUnits,
      avgDuration,
    },
    excess: {
      products: excessProducts,
      avgExcess,
      holdingCost: Math.round(holding),
      totalExcess: Math.round(totalExcess),
    },
    perProduct,
  };
}

export async function runSimulation(user, config) {
  if (usingApi()) return api.runSimulation(user, config);
  await latency(2200);

  const db = getDB(user);
  const today = new Date();
  const DEFAULT_END = today.toISOString().slice(0, 10);
  const endDate = config.endDate || DEFAULT_END;
  const startDate = config.startDate || DEFAULT_END;

  const productIds =
    config.productSelection === 'all'
      ? db.products.map((p) => p.id)
      : (config.productIds || []).length
        ? config.productIds
        : db.products.slice(0, 20).map((p) => p.id);

  if (productIds.length === 0) throw randomError('Select at least one product to simulate.');
  if (startDate >= endDate) throw randomError('The historical period must have a start date before the end date.');

  const selectedProducts = db.products.filter((p) => productIds.includes(p.id));
  if (selectedProducts.length === 0) throw randomError('No products match the selected scope.');

  const avgDaily = selectedProducts.reduce((s, p) => s + p.dailyAvg, 0) / selectedProducts.length;
  const avgLead = selectedProducts.reduce((s, p) => s + p.leadTimeDays, 0) / selectedProducts.length;
  const params =
    config.policy === 'custom'
      ? {
          safety: Number(config.customParams?.safetyStock) || Math.round(avgDaily * avgLead * 0.5),
          reorder: Number(config.customParams?.reorderPoint) || Math.round(avgDaily * avgLead),
          orderQty: Number(config.customParams?.orderQuantity) || Math.round(avgDaily * 30),
        }
      : {
          safety: Math.round(avgDaily * avgLead * 0.5),
          reorder: Math.round(avgDaily * avgLead),
          orderQty: Math.round(avgDaily * 30),
        };

  const simConfig = {
    start: startDate,
    end: endDate,
    pack: Number(config.packSize) || 1,
    orderingCostPerOrder: Number(config.orderingCost) || 500,
    stockoutCostPerUnit: Number(config.stockoutCost) || 1000,
  };

  const hashKey = JSON.stringify({ productIds, startDate, endDate, config });
  const rng = mulberry32(hashString(hashKey)());
  const cachedResult = cache.get(hashKey);
  if (cachedResult) return cachedResult;

  const policy =
    POLICY_PRESETS.find((p) => p.key === config.policy) || POLICY_PRESETS[0];
  const result = runPolicy(
    db,
    productIds,
    { ...simConfig, safety: params.safety, reorder: params.reorder, orderQty: params.orderQty },
    policy,
  );

  // Policy comparison across the three standard presets
  const comparison = {
    metrics: ['Service Level', 'Stockouts', 'Excess Inventory', 'Inventory Cost'],
    rows: [
      {
        metric: 'Service Level',
        format: 'percent',
        values: POLICY_PRESETS.map((pre) => {
          const r = runPolicy(db, productIds, { ...simConfig, safety: params.safety, reorder: params.reorder, orderQty: params.orderQty }, pre);
          return r.kpis.serviceLevel;
        }),
      },
      {
        metric: 'Stockouts',
        format: 'number',
        values: POLICY_PRESETS.map((pre) => {
          const r = runPolicy(db, productIds, { ...simConfig, safety: params.safety, reorder: params.reorder, orderQty: params.orderQty }, pre);
          return r.kpis.stockoutUnits;
        }),
      },
      {
        metric: 'Excess Inventory',
        format: 'number',
        values: POLICY_PRESETS.map((pre) => {
          const r = runPolicy(db, productIds, { ...simConfig, safety: params.safety, reorder: params.reorder, orderQty: params.orderQty }, pre);
          return r.kpis.excessInventory;
        }),
      },
      {
        metric: 'Inventory Cost',
        format: 'currency',
        values: POLICY_PRESETS.map((pre) => {
          const r = runPolicy(db, productIds, { ...simConfig, safety: params.safety, reorder: params.reorder, orderQty: params.orderQty }, pre);
          return r.kpis.inventoryCost;
        }),
      },
    ],
    labels: POLICY_PRESETS.map((p) => p.label),
    raw: POLICY_PRESETS.map((pre) =>
      runPolicy(db, productIds, { ...simConfig, safety: params.safety, reorder: params.reorder, orderQty: params.orderQty }, pre),
    ),
  };

  // Inventory level over time (portfolio aggregate)
  const chart = buildPortfolioTimeline(db, productIds, startDate, endDate);

  const full = {
    config: { ...config, productCount: productIds.length, start: startDate, end: endDate },
    selectedPolicy: policy.label,
    kpis: result.kpis,
    stockout: result.stockout,
    excess: result.excess,
    chart,
    comparison,
    generatedAt: new Date().toISOString(),
  };
  cache.set(hashKey, full);

  db.simulations = [full, ...db.simulations].slice(0, 5);
  db.pushActivity('simulation_completed', `Inventory policy simulation completed for ${productIds.length} SKUs (${policy.label}).`);
  db.pushNotification({
    title: 'Simulation completed.',
    message: `"${policy.label}" was evaluated — service level ${result.kpis.serviceLevel}%.`,
    severity: 'success',
  });
  return full;
}

function buildPortfolioTimeline(db, productIds, start, end) {
  const dates = [];
  for (let d = new Date(start); d <= new Date(end); d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates.map((ds) => {
    let stock = 0;
    for (const id of productIds) {
      const p = db.products.find((x) => x.id === id);
      if (!p) continue;
      const series = db.getSales(p.id);
      const match = series.find((s) => s.date === ds);
      const demand = match ? match.units : 0;
      // Simple projected closing stock per product (no reorder in this view)
      const cumulativeBefore = series.filter((s) => s.date < ds).reduce((s, x) => s + x.units, 0);
      const pastCum = series.filter((s) => s.date <= ds).reduce((s, x) => s + x.units, 0);
      const positionAtEnd = p.currentStock + (p.openOrderQty || 0) - pastCum;
      stock += Math.max(0, positionAtEnd);
      void demand;
      void cumulativeBefore;
    }
    return { date: ds, stock: Math.round(stock) };
  });
}