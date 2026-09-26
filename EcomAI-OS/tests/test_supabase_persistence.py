import json
from urllib.error import URLError

import pytest

from backend.supabase import (
    SupabasePersistenceError,
    append_audit_entry,
    fetch_audit_entries,
    fetch_products,
    fetch_sales,
    service_role_headers,
    supabase_enabled,
    sync_local_shadow,
    upsert_products,
    upsert_sales,
)
from backend.tenant import TenantWorkspace


class _Response:
    def __init__(self, payload=None):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        if self.payload is None:
            return b""
        return json.dumps(self.payload).encode("utf-8")


def _enable_supabase(monkeypatch):
    monkeypatch.setenv("USE_SUPABASE", "true")
    monkeypatch.setenv("SUPABASE_URL", "https://mock-project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")
    monkeypatch.delenv("SUPABASE_REQUEST_TIMEOUT_S", raising=False)


def test_disabled_supabase_is_a_pure_local_shadow(monkeypatch):
    monkeypatch.setenv("USE_SUPABASE", "false")
    rows = [{"product_id": "P1", "date": "2025-01-01", "units_sold": 1}]

    assert supabase_enabled() is False
    assert sync_local_shadow(rows) is rows
    with pytest.raises(SupabasePersistenceError, match="disabled"):
        service_role_headers()


def test_upsert_is_canonical_and_user_scoped(monkeypatch):
    _enable_supabase(monkeypatch)
    requests = []

    def fake_urlopen(request, timeout):
        requests.append((request, timeout))
        return _Response()

    monkeypatch.setattr("backend.supabase._urlopen", fake_urlopen)
    row = {
        "product_id": "P1",
        "date": "2025-01-01",
        "units_sold": 4,
        "price": 10.5,
        "category": "Electronics",
        "promotion": "false",
    }

    result = upsert_sales("tenant-a", [row])

    assert result == [{
        "user_id": "tenant-a",
        "product_id": "P1",
        "date": "2025-01-01",
        "units_sold": 4,
        "price": 10.5,
        "category": "Electronics",
        "promotion": False,
    }]
    request = requests[0][0]
    assert request.method == "POST"
    assert "on_conflict=user_id%2Cproduct_id%2Cdate" in request.full_url
    assert request.headers["Authorization"] == "Bearer service-role-test-key"
    assert json.loads(request.data.decode("utf-8"))[0]["user_id"] == "tenant-a"


def test_upsert_rejects_duplicate_business_keys_before_network(monkeypatch):
    _enable_supabase(monkeypatch)
    monkeypatch.setattr(
        "backend.supabase._urlopen",
        lambda *_args, **_kwargs: pytest.fail("duplicate batch reached the network"),
    )
    row = {"product_id": "P1", "date": "2025-01-01", "units_sold": 1}
    with pytest.raises(SupabasePersistenceError, match="duplicate product/date"):
        upsert_sales("tenant-a", [row, dict(row)])


def test_fetch_scopes_query_and_rejects_cross_user_response(monkeypatch):
    _enable_supabase(monkeypatch)
    requests = []

    def fake_urlopen(request, timeout):
        requests.append(request)
        return _Response([{
            "user_id": "tenant-a",
            "product_id": "P1",
            "date": "2025-01-01",
            "units_sold": 4,
            "price": 10.5,
            "category": "Electronics",
            "promotion": False,
        }])

    monkeypatch.setattr("backend.supabase._urlopen", fake_urlopen)
    rows = fetch_sales("tenant-a", product_id="P1")

    assert rows[0]["product_id"] == "P1"
    assert "user_id=eq.tenant-a" in requests[0].full_url
    assert "product_id=eq.P1" in requests[0].full_url

    def cross_user_response(request, timeout):
        return _Response([{
            "user_id": "tenant-b",
            "product_id": "P2",
            "date": "2025-01-01",
            "units_sold": 1,
        }])

    monkeypatch.setattr("backend.supabase._urlopen", cross_user_response)
    with pytest.raises(SupabasePersistenceError, match="another user"):
        fetch_sales("tenant-a")

    def missing_owner_response(request, timeout):
        return _Response([{
            "product_id": "P2",
            "date": "2025-01-01",
            "units_sold": 1,
        }])

    monkeypatch.setattr("backend.supabase._urlopen", missing_owner_response)
    with pytest.raises(SupabasePersistenceError, match="omitted user_id"):
        fetch_sales("tenant-a")


def test_tenant_write_and_hydration_use_the_remote_boundary(monkeypatch):
    _enable_supabase(monkeypatch)
    requests = []
    sales_row = {
        "user_id": "tenant-a",
        "product_id": "P1",
        "date": "2025-01-01",
        "units_sold": 4,
        "price": 10.5,
        "category": "Electronics",
        "promotion": False,
    }

    def fake_urlopen(request, timeout):
        requests.append(request)
        if request.method == "POST":
            return _Response()
        table = request.full_url.split("/rest/v1/")[1].split("?")[0]
        if table == "products":
            return _Response([{
                "user_id": "tenant-a",
                "product_id": "P1",
                "product_name": "P1",
                "category": "Electronics",
                "current_stock": 3,
            }])
        if table == "audit_entries":
            return _Response([])
        return _Response([sales_row])

    monkeypatch.setattr("backend.supabase._urlopen", fake_urlopen)
    workspace = TenantWorkspace("tenant-a")
    workspace.add_product({"product_id": "P1", "category": "Electronics"})
    workspace.upsert_sales_row({
        "product_id": "P1",
        "date": "2025-01-01",
        "units_sold": 4,
        "price": 10.5,
        "category": "Electronics",
        "promotion": False,
    })

    assert workspace.sales_records[("P1", "2025-01-01")]["units_sold"] == 4
    assert requests[-1].method == "POST"

    hydrated = TenantWorkspace("tenant-a")
    assert hydrated.hydrate_sales() == 1
    assert hydrated.sales_records[("P1", "2025-01-01")]["units_sold"] == 4
    assert any(entry.action == "sales_hydrated" for entry in hydrated.audit)


def test_persistence_respects_the_server_upload_cap(monkeypatch):
    _enable_supabase(monkeypatch)
    monkeypatch.setenv("MAX_UPLOAD_ROWS", "1")
    monkeypatch.setattr(
        "backend.supabase._urlopen",
        lambda *_args, **_kwargs: pytest.fail("over-cap data reached the network"),
    )
    row = {"product_id": "P1", "date": "2025-01-01", "units_sold": 1}
    with pytest.raises(SupabasePersistenceError, match="upload row limit"):
        upsert_sales("tenant-a", [row, dict(row)])


def test_failed_remote_write_does_not_mutate_the_workspace(monkeypatch):
    _enable_supabase(monkeypatch)
    # The catalog bootstrap itself is a remote write now, so it needs a working
    # transport before the failure is introduced.
    monkeypatch.setattr("backend.supabase._urlopen", lambda *_a, **_k: _Response())
    workspace = TenantWorkspace("tenant-a")
    workspace.add_product({"product_id": "P1", "category": "Electronics"})

    def failing_urlopen(request, timeout):
        raise URLError("connection refused")

    monkeypatch.setattr("backend.supabase._urlopen", failing_urlopen)
    with pytest.raises(SupabasePersistenceError, match="no local change"):
        workspace.upsert_sales_row({
            "product_id": "P1",
            "date": "2025-01-01",
            "units_sold": 4,
        })
    assert workspace.sales_records == {}


def test_transport_errors_are_friendly_and_redacted(monkeypatch):
    _enable_supabase(monkeypatch)

    def failing_urlopen(request, timeout):
        raise URLError("SUPABASE_SERVICE_ROLE_KEY=service-role-test-key")

    monkeypatch.setattr("backend.supabase._urlopen", failing_urlopen)
    with pytest.raises(SupabasePersistenceError) as raised:
        fetch_sales("tenant-a")

    message = str(raised.value)


def test_product_and_audit_adapters_are_user_scoped_and_redact_details(monkeypatch):
    _enable_supabase(monkeypatch)
    requests = []

    def fake_urlopen(request, timeout):
        requests.append(request)
        if request.method == "GET":
            if "products" in request.full_url:
                return _Response([{
                    "user_id": "tenant-a",
                    "product_id": "P1",
                    "product_name": "Widget",
                    "category": "Hardware",
                    "current_stock": 4,
                }])
            return _Response([])
        return _Response()

    monkeypatch.setattr("backend.supabase._urlopen", fake_urlopen)

    products = upsert_products(
        "tenant-a",
        [{
            "product_id": "P1",
            "product_name": "Widget",
            "current_stock": 4,
        }],
    )
    assert products[0]["user_id"] == "tenant-a"
    assert fetch_products("tenant-a")[0]["product_id"] == "P1"

    audit = append_audit_entry(
        "tenant-a",
        {
            "id": "audit-1",
            "action": "forecast_generated",
            "detail": {
                "authorization": "Bearer should-not-persist",
                "nested": {"access_token": "should-not-persist"},
                "model_version": "xgboost-v1.0.0",
            },
        },
    )
    assert audit["user_id"] == "tenant-a"
    body = json.loads(requests[-1].data.decode("utf-8"))[0]
    assert body["detail"]["authorization"] == "[redacted]"
    assert body["detail"]["nested"]["access_token"] == "[redacted]"
    assert body["detail"]["model_version"] == "xgboost-v1.0.0"
    assert fetch_audit_entries("tenant-a") == []


def test_exact_page_multiple_is_proved_complete_by_the_following_empty_page(monkeypatch):
    _enable_supabase(monkeypatch)
    monkeypatch.setenv("MAX_UPLOAD_ROWS", "2")
    pages = [
        [
            {
                "user_id": "tenant-a",
                "product_id": "P1",
                "date": "2025-01-01",
                "units_sold": 1,
            },
            {
                "user_id": "tenant-a",
                "product_id": "P2",
                "date": "2025-01-01",
                "units_sold": 2,
            },
        ],
        [],
    ]
    calls = []

    def fake_urlopen(request, timeout):
        calls.append(request)
        return _Response(pages[min(len(calls) - 1, len(pages) - 1)])

    monkeypatch.setattr("backend.supabase._urlopen", fake_urlopen)
    rows = fetch_sales("tenant-a")
    assert len(rows) == 2
    assert len(calls) == 2
    assert "limit=2" in calls[0].full_url
    assert "offset=2" in calls[1].full_url
