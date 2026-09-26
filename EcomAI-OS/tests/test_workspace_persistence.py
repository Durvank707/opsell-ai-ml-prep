"""Product and audit persistence behaviour of :class:`TenantWorkspace`.

These tests cover the tenant workflow end to end with a mocked PostgREST
transport, so they assert which table each write lands in, that a caller
cannot redirect a write to another tenant, and that a failed remote write is
surfaced rather than silently downgraded to a local-only write.
"""

from __future__ import annotations

import json
from urllib.error import URLError

import pytest

from backend.supabase import SupabasePersistenceError
from backend.tenant import TenantIsolationError, TenantWorkspace


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


def _table_of(request) -> str:
    return request.full_url.split("/rest/v1/")[1].split("?")[0]


class _Recorder:
    """Records every request and returns a per-table canned response."""

    def __init__(self, tables=None, *, fail_on=None, failure=None):
        self.requests = []
        self.tables = tables or {}
        self.fail_on = fail_on
        self.failure = failure or URLError("connection refused")

    def __call__(self, request, timeout):
        self.requests.append(request)
        table = _table_of(request)
        if self.fail_on is not None and table == self.fail_on:
            raise self.failure
        if request.method == "POST":
            return _Response()
        return _Response(self.tables.get(table, []))

    def writes_to(self, table: str):
        return [r for r in self.requests if r.method == "POST" and _table_of(r) == table]

    def bodies_for(self, table: str):
        return [json.loads(r.data.decode("utf-8")) for r in self.writes_to(table)]


PRODUCT = {
    "product_id": "P1",
    "product_name": "Widget",
    "category": "Hardware",
    "current_stock": 10,
}


# ---------------------------------------------------------------------------
# 1. Product creation with Supabase disabled
# ---------------------------------------------------------------------------


def test_product_creation_is_local_only_when_supabase_disabled(monkeypatch):
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setattr(
        "backend.supabase._urlopen",
        lambda *_a, **_k: pytest.fail("Supabase was contacted while disabled"),
    )
    workspace = TenantWorkspace("tenant-a")
    product = workspace.add_product(PRODUCT)

    assert product.product_id == "P1"
    assert workspace.products["P1"].current_stock == 10
    assert any(e.action == "product_upserted" for e in workspace.audit)


# ---------------------------------------------------------------------------
# 2-3. Product create and update with Supabase enabled
# ---------------------------------------------------------------------------


def test_product_creation_is_persisted_with_the_workspace_tenant(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    workspace.add_product(PRODUCT)

    writes = recorder.bodies_for("products")
    assert len(writes) == 1
    row = writes[0][0]
    assert row["user_id"] == "tenant-a"
    assert row["product_id"] == "P1"
    assert row["product_name"] == "Widget"
    assert row["current_stock"] == 10
    # A product write is always accompanied by its audit record.
    audit = recorder.bodies_for("audit_entries")
    assert any(item[0]["action"] == "product_upserted" for item in audit)
    # Nothing was written to sales as a side effect.
    assert recorder.writes_to("sales") == []


def test_product_upsert_updates_the_existing_row(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    workspace.add_product(PRODUCT)
    updated = workspace.add_product({**PRODUCT, "current_stock": 42})

    assert updated.current_stock == 42
    assert len(workspace.products) == 1
    writes = recorder.bodies_for("products")
    assert len(writes) == 2
    assert writes[-1][0]["current_stock"] == 42
    # The upsert targets the tenant-scoped conflict key, not a blind insert.
    assert "on_conflict" in recorder.writes_to("products")[-1].full_url
    assert "user_id" in recorder.writes_to("products")[-1].full_url
    assert "product_id" in recorder.writes_to("products")[-1].full_url


# ---------------------------------------------------------------------------
# 4. Product tenant isolation
# ---------------------------------------------------------------------------


def test_caller_cannot_write_a_product_into_another_tenant(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    # A hostile body claiming another tenant's identity must be ignored.
    workspace.add_product({**PRODUCT, "user_id": "tenant-b"})

    row = recorder.bodies_for("products")[0][0]
    assert row["user_id"] == "tenant-a"
    assert "tenant-b" not in json.dumps(row)


def test_a_tenant_cannot_see_another_tenants_products(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder(tables={
        "products": [{**PRODUCT, "user_id": "tenant-b"}],
    })
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    with pytest.raises(SupabasePersistenceError, match="another user"):
        workspace._hydrate_product_rows()
    assert workspace.products == {}


def test_tenant_isolation_error_when_operating_on_a_foreign_product(monkeypatch):
    monkeypatch.setenv("USE_SUPABASE", "false")
    alice = TenantWorkspace("tenant-a")
    alice.add_product(PRODUCT)
    bob = TenantWorkspace("tenant-b")

    with pytest.raises(TenantIsolationError):
        bob.upsert_sales_row({
            "product_id": "P1",
            "date": "2025-01-01",
            "units_sold": 1,
        })
    assert bob.sales_records == {}


def test_hydration_refuses_another_tenants_audit_history(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder(tables={
        "products": [],
        "sales": [],
        "audit_entries": [{
            "id": "x1",
            "user_id": "tenant-b",
            "action": "forecast_generated",
            "product_id": "P9",
            "detail": {},
            "created_at": "2025-01-01T00:00:00+00:00",
        }],
    })
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    with pytest.raises(SupabasePersistenceError, match="another user"):
        workspace.hydrate_from_supabase()
    assert workspace.audit == []


def test_full_hydration_restores_products_sales_and_audit(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder(tables={
        "products": [{**PRODUCT, "user_id": "tenant-a"}],
        "sales": [{
            "user_id": "tenant-a",
            "product_id": "P1",
            "date": "2025-01-01",
            "units_sold": 5,
        }],
        "audit_entries": [{
            "id": "a1",
            "user_id": "tenant-a",
            "action": "sales_upserted",
            "product_id": "P1",
            "detail": {"units_sold": 5},
            "created_at": "2025-01-01T00:00:00+00:00",
        }],
    })
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    counts = workspace.hydrate_from_supabase()

    assert counts["products"] == 1
    assert counts["sales"] == 1
    assert counts["audit"] == 1
    assert workspace.products["P1"].product_name == "Widget"
    assert workspace.sales_records[("P1", "2025-01-01")]["units_sold"] == 5
    # The hydration events themselves are recorded and persisted.
    actions = [item[0]["action"] for item in recorder.bodies_for("audit_entries")]
    assert "products_hydrated" in actions
    assert "sales_hydrated" in actions


# ---------------------------------------------------------------------------
# 5. Audit creation with Supabase disabled
# ---------------------------------------------------------------------------


def test_audit_entries_stay_local_when_supabase_disabled(monkeypatch):
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setattr(
        "backend.supabase._urlopen",
        lambda *_a, **_k: pytest.fail("Supabase was contacted while disabled"),
    )
    workspace = TenantWorkspace("tenant-a")
    workspace.add_product(PRODUCT)

    assert workspace.audit
    for entry in workspace.audit:
        assert entry.user_id == "tenant-a"


# ---------------------------------------------------------------------------
# 6-7. Audit persistence and isolation
# ---------------------------------------------------------------------------


def test_every_audit_event_is_persisted(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    workspace.add_product(PRODUCT)
    workspace.upsert_sales_row({
        "product_id": "P1",
        "date": "2025-01-01",
        "units_sold": 3,
    })

    actions = [item[0]["action"] for item in recorder.bodies_for("audit_entries")]
    assert "product_upserted" in actions
    assert "sales_upserted" in actions
    # Every persisted entry is stamped with this tenant.
    for item in recorder.bodies_for("audit_entries"):
        assert item[0]["user_id"] == "tenant-a"


def test_audit_entry_user_id_cannot_be_forged(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    workspace._audit("forecast_generated", "P1", {"user_id": "tenant-b"})

    row = recorder.bodies_for("audit_entries")[0][0]
    assert row["user_id"] == "tenant-a"


def test_audit_history_is_restored_and_deduplicated(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder(tables={
        "products": [{**PRODUCT, "user_id": "tenant-a"}],
        "sales": [],
        "audit_entries": [
            {
                "id": "a1",
                "user_id": "tenant-a",
                "action": "product_upserted",
                "product_id": "P1",
                "detail": {"current_stock": 10},
                "created_at": "2025-01-01T00:00:00+00:00",
            },
            {
                "id": "a1",
                "user_id": "tenant-a",
                "action": "product_upserted",
                "product_id": "P1",
                "detail": {"current_stock": 10},
                "created_at": "2025-01-01T00:00:00+00:00",
            },
        ],
    })
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    counts = workspace.hydrate_from_supabase()

    # The duplicated remote row is restored once, not twice.
    assert counts["audit"] == 1
    assert [e.id for e in workspace.audit if e.id == "a1"] == ["a1"]
    assert counts["products"] == 1
    assert "P1" in workspace.products


def test_hydration_is_skipped_when_already_done(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder(tables={
        "products": [{**PRODUCT, "user_id": "tenant-a"}],
    })
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    workspace.hydrate_from_supabase()
    reads_after_first = len(recorder.requests)
    workspace.hydrate_from_supabase()

    assert len(recorder.requests) == reads_after_first


def test_hydration_does_not_run_when_supabase_disabled(monkeypatch):
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setattr(
        "backend.supabase._urlopen",
        lambda *_a, **_k: pytest.fail("Supabase was contacted while disabled"),
    )
    workspace = TenantWorkspace("tenant-a")
    assert workspace.hydrate_from_supabase() == {
        "products": 0,
        "sales": 0,
        "audit": 0,
    }
    assert workspace.remote_hydrated is False


# ---------------------------------------------------------------------------
# 8-9. Failure handling
# ---------------------------------------------------------------------------


def test_product_persistence_failure_is_surfaced_and_not_local(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder(fail_on="products")
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    with pytest.raises(SupabasePersistenceError, match="no local change"):
        workspace.add_product(PRODUCT)

    # No local product, and no audit claiming the product was created.
    assert workspace.products == {}
    assert not any(e.action == "product_upserted" for e in workspace.audit)


def test_audit_persistence_failure_is_surfaced_and_not_local(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder(fail_on="audit_entries")
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    with pytest.raises(SupabasePersistenceError, match="no local change"):
        workspace._audit("metrics_recomputed", "P1", {"stockout_risk": 0.1})

    assert workspace.audit == []


def test_transport_failure_message_does_not_leak_credentials(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder(
        fail_on="products",
        failure=URLError("SUPABASE_SERVICE_ROLE_KEY=service-role-test-key"),
    )
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    with pytest.raises(SupabasePersistenceError) as raised:
        workspace.add_product(PRODUCT)

    assert "service-role-test-key" not in str(raised.value)


# ---------------------------------------------------------------------------
# 10. Sales persistence still works through the same workspace
# ---------------------------------------------------------------------------


def test_sales_persistence_is_unchanged(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    workspace = TenantWorkspace("tenant-a")
    workspace.add_product(PRODUCT)
    workspace.upsert_sales_row({
        "product_id": "P1",
        "date": "2025-01-01",
        "units_sold": 7,
    })

    sales = recorder.bodies_for("sales")
    assert len(sales) == 1
    assert sales[0][0]["user_id"] == "tenant-a"
    assert sales[0][0]["units_sold"] == 7
    assert workspace.sales_records[("P1", "2025-01-01")]["units_sold"] == 7
