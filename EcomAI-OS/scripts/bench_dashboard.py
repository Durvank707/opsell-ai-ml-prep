"""Reproducible benchmark for the V2 dashboard read paths.

Times the same five endpoints the dashboard fires on load (recommendations,
inventory/overview, forecast/portfolio, sales/summary, audit trail) against one
seeded tenant workspace, exactly as the frontend does during a React
StrictMode dev mount (a double batch). It also counts how many times the XGBoost
ML adapter actually ran, so a wall-time change can be separated from the raw
compute count.

Hermetic by design: it never inherits the developer's ``.env`` or Supabase
credentials. Run with the project venv from the repository root:

    .venv\\Scripts\\python.exe scripts\\bench_dashboard.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Same hermetic baseline the test suite uses (see tests/conftest.py).
os.environ["ECOMAI_OS_ENV_FILE"] = str(REPO_ROOT / "tests" / "_no_env_file_")
_BASELINE = {
    "APP_ENV": "test",
    "USE_SUPABASE": "false",
    "AUTH_MODE": "jwt",
    "JWT_ALGORITHM": "HS256",
    "JWT_SECRET": "test-only-not-a-real-secret-" + "0" * 32,
    "JWT_CLOCK_SKEW_SECONDS": "0",
    "JWT_USER_ID_CLAIM": "sub",
    "LOCAL_AUTH_ENABLED": "false",
    "V1_ENABLED": "true",
    "V1_REQUIRE_AUTH": "false",
}
for _key in (
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_JWT_SECRET",
    "JWT_ISSUER",
    "JWT_AUDIENCE",
    "JWT_PUBLIC_KEY",
    "JWT_JWKS_URL",
    "JWT_KEY_ID",
    "LOCAL_AUTH_DATABASE_PATH",
    "LOCAL_DATABASE_PATH",
    "JOB_DATABASE_PATH",
    "CORS_ORIGINS",
):
    os.environ.pop(_key, None)
os.environ.update(_BASELINE)


def main() -> None:
    import backend.tenant as tenant
    from backend.tenant import TenantWorkspace, seed_canonical_demo

    # Count real ML series forecasts without perturbing results.
    _original_ml = tenant._ml_forecast
    _calls = {"n": 0}

    def _counting_ml(history, *, horizon=None):
        _calls["n"] += 1
        return _original_ml(history, horizon=horizon)

    tenant._ml_forecast = _counting_ml

    def _seeded(tag: str):
        ws = TenantWorkspace(tag)
        written = seed_canonical_demo(ws)
        print(f"seeded {len(ws.products)} products / {written} sales rows for {tag}")
        return ws

    endpoints = [
        ("recommendations", lambda ws: ws.recommendations()),
        ("inventory/overview", lambda ws: ws.inventory_overview()),
        ("forecast/portfolio h=7", lambda ws: ws.portfolio_forecast(horizon=7)),
        ("sales/summary", lambda ws: ws.sales_summary()),
        ("audit trail", lambda ws: [{"id": e.id} for e in ws.audit]),
    ]

    # Warm the service/model once so timing is not polluted by joblib.load.
    warm = _seeded("bench-warm")
    for _name, fn in endpoints:
        fn(warm)

    ws = _seeded("bench-dashboard")

    print("\nper-endpoint, single call on the same (already-warm) workspace:")
    for name, fn in endpoints:
        samples = []
        _calls["n"] = 0
        for _ in range(3):
            start = time.perf_counter()
            fn(ws)
            samples.append((time.perf_counter() - start) * 1000)
        samples.sort()
        print(
            f"  {name:<26} min={samples[0]:8.1f}ms  "
            f"med={samples[1]:8.1f}ms  (ml_calls over 3 calls={_calls['n']})"
        )

    print("\nfull dashboard double-load (StrictMode remount), cold memo, 2 runs:")
    for run in range(2):
        fresh_ws = _seeded(f"bench-load-{run}")
        _calls["n"] = 0
        start = time.perf_counter()
        for _ in range(2):
            fresh_ws.recommendations()
            fresh_ws.inventory_overview()
            fresh_ws.portfolio_forecast(horizon=7)
            fresh_ws.sales_summary()
            _ = [{"id": e.id} for e in fresh_ws.audit]
        elapsed = (time.perf_counter() - start) * 1000
        print(f"  run {run}: {elapsed:8.1f}ms  (_ml_forecast calls: {_calls['n']})")

    print("\nsingle load on a fresh workspace (cold memo + fresh data):")
    fresh = _seeded("bench-fresh")
    _calls["n"] = 0
    start = time.perf_counter()
    fresh.recommendations()
    fresh.inventory_overview()
    fresh.portfolio_forecast(horizon=7)
    fresh.sales_summary()
    _ = [{"id": e.id} for e in fresh.audit]
    elapsed = (time.perf_counter() - start) * 1000
    print(f"  {elapsed:8.1f}ms  (_ml_forecast calls: {_calls['n']})")


if __name__ == "__main__":
    main()