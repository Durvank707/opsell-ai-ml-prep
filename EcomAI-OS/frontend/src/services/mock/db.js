// Per-user mock database. All data is scoped to a user id so users
// can never see another user's data. Deterministic generation means a
// returning user sees the same stable workspace.

import {
  generateProductList,
  flagStockoutRisk,
  calibrateInventoryValue,
  buildProductSales,
  computeMetrics,
  classifyStatus,
  generateChannel,
} from './catalog';
import { mulberry32, hashString } from '../../lib/utils';

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function broadcast(db) {
  listeners.forEach((fn) => fn(db));
}

let idCounter = 1;
function uid() {
  return `evt_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

const ACTIVITY_TEMPLATES = {
  product_added: { title: 'Added new product', severity: 'success' },
  sales_uploaded: { title: 'Uploaded sales data', severity: 'info' },
  forecast_generated: { title: 'Forecast generated', severity: 'success' },
  inventory_updated: { title: 'Inventory updated', severity: 'info' },
  simulation_completed: { title: 'Simulation completed', severity: 'success' },
  product_deleted: { title: 'Product removed', severity: 'warning' },
  settings_updated: { title: 'Settings updated', severity: 'info' },
};

const DEFAULT_SETTINGS = {
  currency: 'INR',
  defaultLeadTime: 7,
  safetyStockMethod: 'statistical', // statistical | fixed_days
  fixedSafetyDays: 7,
  notifications: {
    lowStock: true,
    stockout: true,
    forecast: true,
    simulation: true,
  },
};

export class MockUserDB {
  constructor(user, { seedDemo = false } = {}) {
    this.user = { ...user };
    this.products = []; // { id, name, category, ...metrics }
    this.salesByProduct = new Map(); // productId -> [{date, units, channel, revenue}]
    this.activity = [];
    this.notifications = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.salesMeta = {
      totalRecords: 0,
      lastImport: null,
      dateFrom: null,
      dateTo: null,
    };
    this.forecasts = new Map(); // `${productId}:${horizon}` -> points
    this.simulations = [];
    this.forecastGenerated = false;
    this.createdAt = Date.now();

    if (seedDemo) this.seedDemoData(user);
  }

  // ---------------------------------------------------------------- seeding

  seedDemoData(user) {
    const seedKey = `${user.id}:${user.email}`;
    this.products = generateProductList(seedKey);
    this.products = flagStockoutRisk(this.products, 8);
    this.products = calibrateInventoryValue(this.products, 1213000);
    // Recompute statuses after value calibration (cost-only change, keep once).
    this.products.forEach((p) => this.recomputeMetrics(p.id, { preserveStock: true }));

    this.salesMeta.lastImport = new Date(Date.now() - 12 * 86400000).toISOString();
    this.salesMeta.totalRecords = this.estimateTotalRecords();
    this.salesMeta.dateFrom = new Date(Date.now() - 119 * 86400000).toISOString().slice(0, 10);
    this.salesMeta.dateTo = new Date().toISOString().slice(0, 10);

    this.activity = [
      {
        id: uid(),
        type: 'sales_uploaded',
        title: 'Uploaded sales data',
        description: 'Imported 12 months of sales history from all channels.',
        time: new Date(Date.now() - 12 * 86400000).toISOString(),
        severity: 'info',
      },
      {
        id: uid(),
        type: 'forecast_generated',
        title: 'Forecast generated',
        description: 'Portfolio demand forecast refreshed for all 245 SKUs.',
        time: new Date(Date.now() - 3 * 86400000).toISOString(),
        severity: 'success',
      },
      {
        id: uid(),
        type: 'inventory_updated',
        title: 'Inventory updated',
        description: 'Stock levels synchronized from your sales channels.',
        time: new Date(Date.now() - 1 * 86400000).toISOString(),
        severity: 'info',
      },
    ];
    this.forecastGenerated = true;

    const critical = this.products.filter((p) => p.status === 'critical').slice(0, 3);
    this.notifications = [
      ...critical.map((p, i) => ({
        id: uid(),
        title: `${p.name} has fallen below its reorder point.`,
        message: `Current stock ${p.currentStock} units is below the reorder point of ${p.reorderPoint}. Recommended order: ${this.recommendedOrderQty(p)} units.`,
        severity: 'critical',
        time: new Date(Date.now() - i * 3600000).toISOString(),
        read: false,
      })),
      {
        id: uid(),
        title: 'Sales data upload completed.',
        message: 'Your historical sales data was validated and imported successfully.',
        severity: 'success',
        time: new Date(Date.now() - 12 * 86400000).toISOString(),
        read: false,
      },
      {
        id: uid(),
        title: 'Demand forecast generated successfully.',
        message: 'The AI demand forecast for your portfolio is ready to view.',
        severity: 'success',
        time: new Date(Date.now() - 3 * 86400000).toISOString(),
        read: true,
      },
      {
        id: uid(),
        title: 'Simulation completed.',
        message: 'Inventory policy simulation finished. Review the policy comparison.',
        severity: 'info',
        time: new Date(Date.now() - 2 * 86400000).toISOString(),
        read: true,
      },
    ];
  }

  estimateTotalRecords() {
    const rand = mulberry32(hashString(`${this.user.id}${this.user.email}:recs`)());
    // Simulate the record count without materialising every row
    let total = 0;
    for (const p of this.products) {
      const activeDays = 120;
      total += Math.round(activeDays * p.dailyAvg * (0.5 + rand() * 0.3));
    }
    return total;
  }

  // ---------------------------------------------------------------- products

  recomputeMetrics(productId, { preserveStock = false } = {}) {
    const p = this.products.find((x) => x.id === productId);
    if (!p) return;
    const { safetyStock, reorderPoint, targetStock } = computeMetrics(
      p.dailyAvg,
      p.sigma,
      p.leadTimeDays,
      p.minStock,
    );
    p.safetyStock = safetyStock;
    p.reorderPoint = reorderPoint;
    p.targetStock = targetStock;
    if (!preserveStock) {
      // Bring stock into a valid bucket range after manual edits.
    }
    p.status = classifyStatus(p.currentStock, safetyStock, reorderPoint, targetStock);
    p.inventoryPosition = p.currentStock + (p.openOrderQty || 0);
    p.daysOfInventory = Math.round((p.currentStock / Math.max(p.dailyAvg, 0.05)) * 10) / 10;
    p.updatedAt = new Date().toISOString();
  }

  recommendedOrderQty(product) {
    if (product.status === 'healthy' || product.status === 'overstocked') return 0;
    const deficit = product.targetStock - product.inventoryPosition;
    if (deficit <= 0) return 0;
    const pack = 5;
    return Math.ceil(deficit / pack) * pack;
  }

  addProduct(payload) {
    const nowIso = new Date().toISOString();
    const nextNum = this.products.length + 1;
    const dailyAvg = Math.max(0.3, Math.round((Number(payload.currentStock) / 14) * 10) / 10);
    const sigma = dailyAvg * 0.4;
    const lead = Number(payload.leadTimeDays) || this.settings.defaultLeadTime;
    const { safetyStock, reorderPoint, targetStock } = computeMetrics(
      dailyAvg,
      sigma,
      lead,
      Number(payload.minStock) || 0,
    );
    const currentStock = Number(payload.currentStock) || 0;
    const product = {
      id: payload.productId || `P${String(nextNum).padStart(3, '0')}`,
      sku: payload.productId || `NEW-${String(nextNum).padStart(4, '0')}`,
      name: payload.name,
      category: payload.category,
      description: payload.description || '',
      unitCost: Number(payload.unitCost) || 0,
      sellingPrice: Number(payload.sellingPrice) || 0,
      currentStock,
      minStock: Number(payload.minStock) || 0,
      openOrderQty: 0,
      expectedArrival: null,
      leadTimeDays: lead,
      supplier: payload.supplier || 'Not specified',
      dailyAvg,
      sigma: Math.round(sigma * 10) / 10,
      safetyStock,
      reorderPoint,
      targetStock,
      status: 'healthy',
      stockoutRisk: false,
      inventoryPosition: currentStock,
      daysOfInventory: Math.round((currentStock / Math.max(dailyAvg, 0.05)) * 10) / 10,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    product.status = classifyStatus(product.currentStock, safetyStock, reorderPoint, targetStock);
    this.products.push(product);
    this.pushActivity('product_added', `Added ${product.name} to the catalog.`);
    this.salesByProduct.set(product.id, []);
    broadcast(this);
    return product;
  }

  updateProduct(id, patch) {
    const p = this.products.find((x) => x.id === id);
    if (!p) throw new Error('Product not found');
    Object.assign(p, patch);
    if (patch.leadTimeDays !== undefined || patch.minStock !== undefined || patch.dailyAvg !== undefined) {
      this.recomputeMetrics(id);
    } else {
      p.status = classifyStatus(p.currentStock, p.safetyStock, p.reorderPoint, p.targetStock);
      p.inventoryPosition = p.currentStock + (p.openOrderQty || 0);
      p.updatedAt = new Date().toISOString();
    }
    this.pushActivity('inventory_updated', `Updated stock details for ${p.name}.`);
    broadcast(this);
    return p;
  }

  deleteProduct(id) {
    const p = this.products.find((x) => x.id === id);
    if (!p) throw new Error('Product not found');
    this.products = this.products.filter((x) => x.id !== id);
    this.salesByProduct.delete(id);
    this.forecasts.delete(`${id}:30`);
    this.pushActivity('product_deleted', `Removed ${p.name} from the catalog.`);
    broadcast(this);
  }

  // ---------------------------------------------------------------- sales

  getSales(productId) {
    let series = this.salesByProduct.get(productId);
    if (!series) {
      const p = this.products.find((x) => x.id === productId);
      if (!p) return [];
      const rand = mulberry32(hashString(`${this.user.id}:${this.user.email}:${productId}:sales`)());
      series = buildProductSales(`${this.user.id}:${productId}`, p, 120);
      this.salesByProduct.set(productId, series);
    }
    return series;
  }

  allSalesRecords() {
    const records = [];
    for (const p of this.products) {
      const series = this.getSales(p.id);
      for (const s of series) {
        if (s.units > 0) records.push({ ...s, productId: p.id, productName: p.name, category: p.category });
      }
    }
    return records;
  }

  importSalesRows(rows) {
    const importedByProduct = new Map();
    let total = 0;
    let dateMin = null;
    let dateMax = null;
    for (const row of rows) {
      const { date, productId, units } = row;
      const p = this.products.find((x) => x.id === productId || x.sku === productId);
      if (!p) continue;
      const u = Math.max(0, Number(units) || 0);
      let list = importedByProduct.get(p.id);
      if (!list) {
        list = [];
        importedByProduct.set(p.id, list);
      }
      list.push({ date, units: u, channel: row.channel || 'Import', revenue: Math.round(u * p.sellingPrice) });
      total += u;
      if (!dateMin || date < dateMin) dateMin = date;
      if (!dateMax || date > dateMax) dateMax = date;
    }
    for (const [pid, rowsList] of importedByProduct) {
      const existing = this.salesByProduct.get(pid) || [];
      // Merge by date (imports overwrite same-date records)
      const map = new Map(existing.map((s) => [s.date + '|' + s.channel, s]));
      for (const row of rowsList) map.set(row.date + '|' + row.channel, row);
      this.salesByProduct.set(pid, [...map.values()].sort((a, b) => a.date.localeCompare(b.date)));
    }
    if (total > 0) {
      this.salesMeta.lastImport = new Date().toISOString();
      this.salesMeta.totalRecords += rows.length;
      if (dateMin && (!this.salesMeta.dateFrom || dateMin < this.salesMeta.dateFrom)) this.salesMeta.dateFrom = dateMin;
      if (dateMax && (!this.salesMeta.dateTo || dateMax > this.salesMeta.dateTo)) this.salesMeta.dateTo = dateMax;
      this.pushActivity('sales_uploaded', `Imported ${rows.length} validated sales records.`);
      this.pushNotification({
        title: 'Sales data upload completed.',
        message: `${rows.length} records were imported and validated successfully.`,
        severity: 'success',
      });
    }
    broadcast(this);
    return { importedRows: importedByProduct.size, totalUnits: total };
  }

  // ---------------------------------------------------------------- events

  pushActivity(type, description) {
    const tpl = ACTIVITY_TEMPLATES[type] || { title: type, severity: 'info' };
    this.activity = [
      {
        id: uid(),
        type,
        title: tpl.title,
        description,
        time: new Date().toISOString(),
        severity: tpl.severity,
      },
      ...this.activity,
    ].slice(0, 20);
  }

  pushNotification({ title, message, severity = 'info' }) {
    this.notifications = [
      { id: uid(), title, message, severity, time: new Date().toISOString(), read: false },
      ...this.notifications,
    ].slice(0, 30);
  }

  markNotificationRead(id) {
    const n = this.notifications.find((x) => x.id === id);
    if (n) n.read = true;
  }

  markAllNotificationsRead() {
    this.notifications.forEach((n) => (n.read = true));
    broadcast(this);
  }

  unreadCount() {
    return this.notifications.filter((n) => !n.read).length;
  }

  // ---------------------------------------------------------------- setup

  setupProgress() {
    const steps = [
      {
        key: 'products',
        title: 'Add Products',
        description: 'Add your products and inventory information.',
        complete: this.products.length > 0,
        url: '/app/products',
      },
      {
        key: 'sales',
        title: 'Import Sales Data',
        description: 'Upload historical sales data so EcomAI-OS can understand demand.',
        complete: this.salesMeta.totalRecords > 0 && this.salesByProduct.size > 0,
        url: '/app/sales',
      },
      {
        key: 'forecast',
        title: 'Generate Forecast',
        description: 'Run your first demand forecast after enough sales history is available.',
        complete: this.forecastGenerated,
        url: '/app/forecast',
      },
    ];
    return {
      steps,
      completed: steps.filter((s) => s.complete).length,
      total: steps.length,
      complete: steps.every((s) => s.complete),
    };
  }
}

// ------------------------------------------------------------------ registry

const DB = new Map(); // userId -> MockUserDB

export function getDB(user) {
  let db = DB.get(user.id);
  if (!db) {
    const isDemo =
      user.email === 'demo@ecomai.app' || user.flags?.seedDemoData === true;
    db = new MockUserDB(user, { seedDemo: isDemo });
    DB.set(user.id, db);
  }
  return db;
}

export function releaseDB(userId) {
  DB.delete(userId);
}

/** Small delay to model network latency for a snappy, realistic loading state. */
export function latency(ms = 350) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomError(msg) {
  const e = new Error(msg);
  e.isAppError = true;
  return e;
}