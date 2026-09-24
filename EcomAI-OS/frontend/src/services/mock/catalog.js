// Realistic mock catalog + sales generation for the demo workspace.
// Deterministic per user so multi-tenant isolation is visible and stable.

import { mulberry32, hashString } from '../../lib/utils';

export const CATEGORIES = [
  'Electronics',
  'Accessories',
  'Audio',
  'Wearables',
  'Home & Kitchen',
  'Gaming',
  'Office',
  'Mobile',
];

const SUPPLIERS = [
  'TechSource India',
  'Prime Distributors',
  'Globetech Trading',
  'Oceanic Supply Co',
  'Elektra Wholesale',
  'Nexa Imports',
  'Bluepeak Logistics',
  'Sarda Retail Partners',
];

// Product templates: [name, category, baseCost, popularity 1-5, leadTimeDays, variantCount]
const BASE_CATALOG = [
  ['Wireless Mouse', 'Electronics', 420, 4, 6, 4],
  ['Wired Mouse', 'Electronics', 180, 3, 5, 2],
  ['Mechanical Keyboard', 'Electronics', 1450, 4, 8, 4],
  ['TKL Keyboard', 'Electronics', 1100, 3, 8, 1],
  ['USB-C Hub 7-in-1', 'Electronics', 950, 4, 7, 3],
  ['HDMI Cable 2m', 'Electronics', 220, 4, 4, 2],
  ['USB-C Cable 1m', 'Electronics', 160, 5, 4, 3],
  ['Webcam 1080p', 'Electronics', 1250, 3, 9, 2],
  ['27" Monitor', 'Electronics', 18900, 2, 12, 1],
  ['24" Monitor', 'Electronics', 11500, 2, 12, 0],
  ['Laptop Stand', 'Electronics', 900, 3, 6, 2],
  ['SSD 1TB Portable', 'Electronics', 6200, 3, 10, 2],
  ['Power Strip 6-Way', 'Electronics', 420, 3, 5, 1],
  ['Smart Plug', 'Electronics', 780, 2, 7, 1],
  ['WiFi Router AX3000', 'Electronics', 3100, 2, 9, 0],
  ['65W GaN Charger', 'Electronics', 850, 4, 6, 3],
  ['Phone Case', 'Accessories', 240, 5, 4, 4],
  ['Tempered Glass Protector', 'Accessories', 120, 5, 4, 3],
  ['Laptop Sleeve 14"', 'Accessories', 520, 3, 6, 2],
  ['Laptop Backpack', 'Accessories', 1300, 3, 8, 2],
  ['Power Bank 10000mAh', 'Accessories', 950, 4, 6, 2],
  ['Power Bank 20000mAh', 'Accessories', 1600, 3, 7, 1],
  ['Travel Wallet', 'Accessories', 380, 2, 5, 1],
  ['Polarized Sunglasses', 'Accessories', 480, 2, 6, 2],
  ['Baseball Cap', 'Accessories', 280, 3, 4, 2],
  ['Insulated Water Bottle', 'Accessories', 420, 3, 5, 2],
  ['Hardcover Notebook A5', 'Accessories', 180, 4, 4, 2],
  ['Gel Pen Set (12)', 'Accessories', 220, 3, 4, 0],
  ['Desk Organizer', 'Accessories', 480, 2, 6, 1],
  ['Extended Mouse Pad', 'Accessories', 320, 4, 5, 2],
  ['Wrist Rest', 'Accessories', 260, 2, 5, 0],
  ['Bluetooth Speaker', 'Audio', 1350, 4, 7, 3],
  ['True Wireless Earbuds', 'Audio', 1100, 5, 6, 4],
  ['On-Ear Headphones', 'Audio', 890, 4, 6, 2],
  ['Over-Ear Headphones', 'Audio', 2600, 3, 8, 2],
  ['Soundbar 2.1', 'Audio', 5200, 2, 10, 1],
  ['USB Microphone', 'Audio', 1800, 2, 8, 1],
  ['Earbud Carry Case', 'Audio', 260, 3, 5, 2],
  ['Aux Audio Cable 1.5m', 'Audio', 140, 4, 4, 1],
  ['Smartwatch', 'Wearables', 2400, 4, 9, 3],
  ['Smart Band', 'Wearables', 1300, 4, 7, 2],
  ['Fitness Tracker', 'Wearables', 1100, 3, 7, 1],
  ['Watch Strap 22mm', 'Wearables', 320, 2, 5, 2],
  ['LED Bulb 9W', 'Home & Kitchen', 140, 5, 4, 2],
  ['Smart Bulb Color', 'Home & Kitchen', 520, 3, 6, 2],
  ['Table Lamp', 'Home & Kitchen', 680, 2, 7, 1],
  ['Ceramic Coffee Mug', 'Home & Kitchen', 220, 4, 5, 2],
  ['Stainless Vacuum Flask', 'Home & Kitchen', 580, 3, 6, 1],
  ['Air Fryer 4L', 'Home & Kitchen', 3400, 3, 9, 1],
  ['Blender 500W', 'Home & Kitchen', 1800, 2, 8, 0],
  ['Electric Kettle 1.5L', 'Home & Kitchen', 780, 4, 6, 1],
  ['2-Slice Toaster', 'Home & Kitchen', 950, 2, 7, 0],
  ['Cotton Curtain Pair', 'Home & Kitchen', 620, 2, 6, 2],
  ['Cushion Cover Set', 'Home & Kitchen', 380, 3, 5, 2],
  ['Yoga Mat 6mm', 'Home & Kitchen', 480, 3, 5, 1],
  ['Game Controller', 'Gaming', 1450, 4, 7, 2],
  ['Gaming Mouse RGB', 'Gaming', 780, 4, 6, 2],
  ['Gaming Keyboard', 'Gaming', 1250, 3, 8, 1],
  ['Controller Grip', 'Gaming', 380, 2, 5, 1],
  ['Gaming Headset', 'Gaming', 1680, 3, 7, 1],
  ['Capture Card 1080p60', 'Gaming', 3800, 2, 9, 0],
  ['Racing Wheel Set', 'Gaming', 8900, 1, 12, 0],
  ['Ergonomic Office Chair', 'Office', 8900, 2, 14, 1],
  ['Standing Desk', 'Office', 17500, 1, 15, 0],
  ['LED Desk Lamp', 'Office', 950, 3, 7, 2],
  ['Magnetic Whiteboard', 'Office', 1200, 2, 8, 1],
  ['Filing Cabinet 2-Drawer', 'Office', 3400, 1, 12, 0],
  ['Laser Printer', 'Office', 6800, 1, 10, 0],
  ['Smartphone', 'Mobile', 14500, 3, 10, 2],
  ['10" Tablet', 'Mobile', 11500, 2, 9, 1],
  ['E-Reader 6"', 'Mobile', 6800, 2, 9, 0],
  ['Selfie Stick Tripod', 'Mobile', 480, 2, 5, 1],
  ['Phone Tripod Stand', 'Mobile', 380, 2, 6, 1],
  ['Magnetic Car Mount', 'Mobile', 320, 3, 5, 1],
];

const VARIANT_SUFFIXES = ['', ' Pro', ' Mini', ' Max', ' Lite', ' Plus', ' 2-in-1', ' Deluxe', ' Slim', ' Travel', ' Combo', ' XL'];

export function getSuppliers() {
  return [...SUPPLIERS];
}

const DAILY_AVG_BY_POP = { 1: 0.9, 2: 2.2, 3: 4.4, 4: 8.4, 5: 12.5 };
// Demand multiplier by weekday: Sun..Sat (Indian weekend effect)
const WEEKDAY_FACTOR = [0.8, 0.9, 0.95, 1.0, 1.08, 1.3, 1.18];

function roundStock(v) {
  return Math.max(1, Math.round(v));
}

/**
 * Compute standard inventory metrics for a product.
 * d = daily average demand, sigma = daily demand std-dev.
 */
export function computeMetrics(d, sigma, leadTimeDays, minStock) {
  const safetyStock = roundStock(1.28 * sigma * Math.sqrt(leadTimeDays));
  const leadTimeDemand = Math.round(d * leadTimeDays);
  const reorderPoint = Math.max(roundStock(leadTimeDemand + safetyStock), minStock || 0);
  const targetStock = Math.max(roundStock(d * 30 + safetyStock), reorderPoint + 1);
  return { safetyStock, reorderPoint, targetStock, leadTimeDemand };
}

/** Classify inventory health bucket. */
export function classifyStatus(stock, safetyStock, reorderPoint, targetStock) {
  if (stock <= safetyStock) return 'critical';
  if (stock <= reorderPoint) return 'low';
  if (stock > targetStock * 1.35) return 'overstocked';
  return 'healthy';
}

/**
 * Build the full product list for a user (deterministic).
 * Returns array of product records with computed metrics + a calibrated
 * distribution of health buckets. Calibration targets closely match the
 * product-spec dashboard numbers (245 SKUs, ~8% critical, ~13% at risk,
 * ~21 overstocked, ~₹12.4L inventory value).
 */
export function generateProductList(seedKey) {
  const rand = mulberry32(hashString(seedKey)());
  const products = [];

  // Expand templates into exactly 245 SKUs.
  const totalTarget = 245;
  let baseIdx = 0;
  while (products.length < totalTarget) {
    const base = BASE_CATALOG[baseIdx % BASE_CATALOG.length];
    const variantIndex = products.length; // coarse but deterministic
    const suffix =
      VARIANT_SUFFIXES[(Math.floor(variantIndex / 3)) % VARIANT_SUFFIXES.length];
    if (!products.some((p) => p.name === base[0] + suffix && p.baseName === base[0])) {
      products.push({
        baseName: base[0],
        name: base[0] + suffix,
        category: base[1],
        baseCost: base[2],
        popularity: base[3],
        leadTimeDays: base[4],
      });
    }
    baseIdx++;
  }

  // Assign each product its health bucket by target counts.
  // critical 20, low 32, overstocked 21, healthy 172.
  const order = [];
  for (let i = 0; i < 20; i++) order.push('critical');
  for (let i = 0; i < 32; i++) order.push('low');
  for (let i = 0; i < 21; i++) order.push('overstocked');
  while (order.length < totalTarget) order.push('healthy');
  // Shuffle deterministically
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const now = Date.now();
  return products.map((base, idx) => {
    const bucket = order[idx];
    const costJitter = 0.85 + rand() * 0.3;
    const unitCost = Math.round(base.baseCost * costJitter);
    const markup = 1.35 + rand() * 0.85;
    const sellingPrice = Math.round(unitCost * markup);
    const dailyAvg = DAILY_AVG_BY_POP[base.popularity] * (0.75 + rand() * 0.5);
    const sigma = dailyAvg * (0.32 + rand() * 0.25);
    const lead = base.leadTimeDays;
    const minStock = 0;
    const { safetyStock, reorderPoint, targetStock } = computeMetrics(dailyAvg, sigma, lead, minStock);

    let currentStock;
    if (bucket === 'critical') currentStock = 1 + Math.floor(rand() * safetyStock);
    else if (bucket === 'low') currentStock = safetyStock + 1 + Math.floor(rand() * Math.max(1, reorderPoint - safetyStock));
    else if (bucket === 'overstocked') currentStock = Math.ceil(targetStock * (1.4 + rand() * 0.5));
    else currentStock = reorderPoint + 1 + Math.floor(rand() * Math.max(1, Math.ceil(targetStock * 1.25) - reorderPoint));

    const status = classifyStatus(currentStock, safetyStock, reorderPoint, targetStock);
    const openOrderQty = status === 'low' ? Math.max(1, Math.floor(rand() * 60)) : 0;
    const inventoryPosition = currentStock + openOrderQty;
    const daysOfInventory = currentStock / Math.max(dailyAvg, 0.05);

    return {
      id: `P${String(idx + 1).padStart(3, '0')}`,
      sku: `${base.category.slice(0, 2).toUpperCase()}-${String(idx + 1).padStart(4, '0')}`,
      name: base.name,
      category: base.category,
      description: `${base.name} — retail quality stock for the ${base.category} range.`,
      unitCost,
      sellingPrice,
      currentStock: roundStock(currentStock),
      minStock,
      openOrderQty,
      expectedArrival: null,
      leadTimeDays: lead,
      supplier: SUPPLIERS[Math.floor(rand() * SUPPLIERS.length)],
      dailyAvg: Math.round(dailyAvg * 10) / 10,
      sigma: Math.round(sigma * 10) / 10,
      safetyStock,
      reorderPoint,
      targetStock,
      status,
      stockoutRisk: false,
      inventoryPosition,
      daysOfInventory: Math.round(daysOfInventory * 10) / 10,
      createdAt: new Date(now - (20 + Math.floor(rand() * 120)) * 86400000).toISOString(),
      updatedAt: new Date(now - Math.floor(rand() * 10) * 86400000).toISOString(),
    };
  });
}

/**
 * Deterministically flag `n` critical products as imminent stockout risk
 * (stock will deplete before an expedited order can arrive).
 */
export function flagStockoutRisk(products, count) {
  const candidates = products
    .filter((p) => p.status === 'critical')
    .sort((a, b) => a.daysOfInventory - b.daysOfInventory);
  let flagged = 0;
  for (const p of products) {
    const imminent = p.currentStock < p.dailyAvg * p.leadTimeDays * 0.9;
    p.stockoutRisk = false;
    if (imminent && flagged < count) {
      p.stockoutRisk = true;
      flagged++;
    }
  }
  if (flagged < count) {
    for (const p of candidates) {
      if (flagged >= count) break;
      if (!p.stockoutRisk) {
        p.stockoutRisk = true;
        flagged++;
      }
    }
  }
  return products;
}

/**
 * Scale unit costs so total inventory value lands near the target (₹12.4L),
 * then recompute selling prices from the markup implied by each product.
 * The factor is clamped only to keep prices sane in extreme cases — a catalog
 * several multiples above the target still gets scaled down to land on it.
 */
export function calibrateInventoryValue(products, targetValue = 1240000) {
  const rawValue = products.reduce((s, p) => s + p.currentStock * p.unitCost, 0);
  let factor = targetValue / Math.max(rawValue, 1);
  factor = Math.min(1.35, Math.max(0.02, factor));
  for (const p of products) {
    const margin = p.sellingPrice / Math.max(p.unitCost, 1);
    p.unitCost = Math.max(9, Math.round(p.unitCost * factor));
    p.sellingPrice = Math.max(p.unitCost + 15, Math.round(p.unitCost * margin));
  }
  return products;
}

/**
 * Generate ~120 days of daily sales history for one product.
 * Deterministic given a per-product RNG. Returns [{ date, units }].
 */
export function generateSalesSeries(rand, dailyAvg, sigma, days = 120) {
  const trend = -0.002 + rand() * 0.005; // -0.2% .. +0.3% per day
  const series = [];
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const weekday = WEEKDAY_FACTOR[d.getDay()];
    const noise = (rand() + rand() - 1) * 0.42; // triangular-ish noise
    const promo = rand() < 0.03 ? 1.7 : 1;
    const units = Math.max(
      0,
      Math.round(dailyAvg * weekday * (1 + trend * i) * (1 + noise) * promo),
    );
    series.push({ date: d.toISOString().slice(0, 10), units });
  }
  return series;
}

export function generateChannel(rand) {
  const r = rand();
  if (r < 0.42) return 'Online Store';
  if (r < 0.68) return 'Amazon';
  if (r < 0.84) return 'Flipkart';
  if (r < 0.94) return 'Myntra';
  return 'Offline Store';
}

/** Build the full sales history for a product and attach channel per record. */
export function buildProductSales(seedKey, product, days = 120) {
  const rand = mulberry32(hashString(seedKey + ':' + product.id)());
  const series = generateSalesSeries(rand, product.dailyAvg, product.sigma, days);
  return series.map((s) => ({
    ...s,
    channel: generateChannel(rand),
    revenue: Math.round(s.units * product.sellingPrice),
  }));
}