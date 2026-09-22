const API_BASE = '/api';

export async function fetchHealth() {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error('Health check failed');
  return res.json();
}

export async function fetchProducts() {
  const res = await fetch(`${API_BASE}/products`);
  if (!res.ok) throw new Error('Failed to fetch products');
  return res.json();
}

export async function fetchProduct(productId) {
  const res = await fetch(`${API_BASE}/products/${productId}`);
  if (!res.ok) throw new Error(`Failed to fetch product ${productId}`);
  return res.json();
}

export async function fetchInventoryOverview() {
  const res = await fetch(`${API_BASE}/inventory/overview`);
  if (!res.ok) throw new Error('Failed to fetch inventory overview');
  return res.json();
}

export async function generateForecast(productId, horizon = 30, scenario = null) {
  const payload = {
    product_id: productId,
    horizon,
    scenario: scenario || null,
  };
  const res = await fetch(`${API_BASE}/forecast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to generate forecast');
  return res.json();
}

export async function fetchReorderRecommendation(productId, moq = 0, packSize = 1) {
  const params = new URLSearchParams({
    moq: moq.toString(),
    pack_size: packSize.toString(),
  });
  const res = await fetch(`${API_BASE}/inventory/reorder/${productId}?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch reorder recommendation');
  return res.json();
}

export async function fetchStockoutTimeline(productId) {
  const res = await fetch(`${API_BASE}/inventory/timeline/${productId}`);
  if (!res.ok) throw new Error('Failed to fetch stockout timeline');
  return res.json();
}

export async function runBacktest(requestPayload) {
  const res = await fetch(`${API_BASE}/simulation/backtest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestPayload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Backtest failed' }));
    throw new Error(err.detail || 'Backtest failed');
  }
  return res.json();
}
