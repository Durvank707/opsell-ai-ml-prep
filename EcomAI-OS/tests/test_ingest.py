"""Tests for the authenticated V2 ingest path.

``POST /api/v2/ingest`` is the only route that makes the tenant workspace
durable, so these tests pin the properties that matter: the tenant always comes
from the signed token, a batch is all-or-nothing, the upload cap cannot be
raised by the client, unknown products are refused rather than invented, and a
failed remote write surfaces as a failure instead of a local-only success.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from urllib.error import URLError

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routers import v2
from backend.tenant import TenantWorkspace


SECRET = "test-" + secrets.token_urlsafe(48)
client = TestClient(app)

PRODUCT = {
    "product_id": "P1",
    "product_name": "Widget",
    "category": "Electronics",
    "current_stock": 10,
}


def _b64(value: dict) -> str:
    encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode("ascii")


def _token(subject: str) -> str:
    now = time.time()
    header = _b64({"alg": "HS256", "typ": "JWT"})
    payload = _b64({"sub": subject, "iat": now, "exp": now + 3600})
    signing_input = f"{header}.{payload}".encode("ascii")
    signature = hmac.new(
        SECRET.encode("utf-8"), signing_input, hashlib.sha256
    ).digest()
    return f"{header}.{payload}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


@pytest.fixture(autouse=True)
def jwt_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setattr(v2, "_WORKSPACES", {})


def _ingest(body, *, user="ingest-user", token_subject=None):
    return client.post(
        "/api/v2/ingest",
        json=body,
        headers={"Authorization": f"Bearer {_token(token_subject or user)}"},
    )


def _sales_rows(count=3, product_id="P1"):
    return [
        {
            "product_id": product_id,
            "date": f"2025-05-{index + 1:02d}",
            "units_sold": index + 1,
        }
        for index in range(count)
    ]


# ---------------------------------------------------------------------------
# Authentication and tenant binding
# ---------------------------------------------------------------------------


def test_ingest_requires_a_bearer_token():
    response = client.post(
        "/api/v2/ingest", json={"user_id": "x", "record_type": "product", "rows": [PRODUCT]}
    )
    assert response.status_code == 401


def test_ingest_rejects_a_cross_tenant_user_id():
    response = _ingest(
        {"user_id": "someone-else", "record_type": "product", "rows": [PRODUCT]},
        user="ingest-user",
    )
    assert response.status_code == 403


def test_caller_supplied_user_id_cannot_redirect_the_write(monkeypatch):
    _ingest({"user_id": "ingest-user", "record_type": "product", "rows": [PRODUCT]})
    ws = v2._WORKSPACES["ingest-user"]
    assert "P1" in ws.products
    assert "someone-else" not in v2._WORKSPACES


# ---------------------------------------------------------------------------
# Validation gating
# ---------------------------------------------------------------------------


def test_invalid_rows_are_refused_and_nothing_is_written():
    response = _ingest({
        "user_id": "ingest-user",
        "record_type": "product",
        "rows": [{**PRODUCT, "current_stock": -5}],
    })
    assert response.status_code == 422
    ws = v2._WORKSPACES.get("ingest-user")
    assert ws is None or ws.products == {}


def test_one_bad_row_refuses_the_whole_batch():
    _ingest({"user_id": "ingest-user", "record_type": "product", "rows": [PRODUCT]})
    response = _ingest({
        "user_id": "ingest-user",
        "record_type": "product",
        "rows": [
            {**PRODUCT, "product_id": "P2", "current_stock": 3},
            {**PRODUCT, "product_id": "P3", "current_stock": -1},
        ],
    })
    assert response.status_code == 422
    ws = v2._WORKSPACES["ingest-user"]
    assert "P2" not in ws.products, "a rejected batch must not partially write"


def test_unknown_record_type_is_refused():
    response = _ingest({
        "user_id": "ingest-user", "record_type": "inventory", "rows": [PRODUCT],
    })
    assert response.status_code == 422
    assert "inventory" in response.json()["detail"]


def test_empty_rows_are_refused():
    response = _ingest({"user_id": "ingest-user", "record_type": "sales", "rows": []})
    assert response.status_code == 422


def test_upload_cap_cannot_be_raised_by_the_client(monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_ROWS", "2")
    response = _ingest({
        "user_id": "ingest-user",
        "record_type": "product",
        "rows": [PRODUCT, {**PRODUCT, "product_id": "P2"}, {**PRODUCT, "product_id": "P3"}],
        "max_rows": 1000,
    })
    assert response.status_code == 413


# ---------------------------------------------------------------------------
# Product catalog first, then sales
# ---------------------------------------------------------------------------


def test_sales_ingest_requires_the_product_to_exist_first():
    response = _ingest({
        "user_id": "ingest-user", "record_type": "sales", "rows": _sales_rows(),
    })
    assert response.status_code == 422
    assert "P1" in response.json()["detail"]


def test_full_ingest_then_read_back():
    assert _ingest({
        "user_id": "ingest-user", "record_type": "product", "rows": [PRODUCT],
    }).status_code == 200
    response = _ingest({
        "user_id": "ingest-user", "record_type": "sales", "rows": _sales_rows(),
    })
    assert response.status_code == 200
    body = response.json()
    assert body["ingested_rows"] == 3
    assert body["durable"] is False
    assert body["persisted_to"] == "memory"

    ws = v2._WORKSPACES["ingest-user"]
    assert len(ws.sales_records) == 3
    assert ws.sales_records[("P1", "2025-05-02")]["units_sold"] == 2


def test_reingesting_the_same_rows_updates_rather_than_duplicates():
    _ingest({"user_id": "ingest-user", "record_type": "product", "rows": [PRODUCT]})
    _ingest({
        "user_id": "ingest-user", "record_type": "sales", "rows": _sales_rows(),
    })
    _ingest({
        "user_id": "ingest-user",
        "record_type": "sales",
        "rows": [{"product_id": "P1", "date": "2025-05-01", "units_sold": 99}],
    })
    ws = v2._WORKSPACES["ingest-user"]
    assert len(ws.sales_records) == 3
    assert ws.sales_records[("P1", "2025-05-01")]["units_sold"] == 99


def test_ingest_creates_an_audit_trail():
    _ingest({"user_id": "ingest-user", "record_type": "product", "rows": [PRODUCT]})
    _ingest({
        "user_id": "ingest-user", "record_type": "sales", "rows": _sales_rows(),
    })
    ws = v2._WORKSPACES["ingest-user"]
    actions = [entry.action for entry in ws.audit]
    assert "product_upserted" in actions
    assert actions.count("sales_upserted") == 3
    assert all(entry.user_id == "ingest-user" for entry in ws.audit)


# ---------------------------------------------------------------------------
# Supabase enabled
# ---------------------------------------------------------------------------


class _Response:
    def __init__(self, payload=None):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return b"" if self.payload is None else json.dumps(self.payload).encode()


class _Recorder:
    def __init__(self, *, fail_on=None):
        self.requests = []
        self.fail_on = fail_on

    def __call__(self, request, timeout):
        self.requests.append(request)
        table = request.full_url.split("/rest/v1/")[1].split("?")[0]
        if table == self.fail_on:
            raise URLError("connection refused")
        if request.method == "POST":
            return _Response()
        return _Response([])

    def writes(self, table):
        return [
            r for r in self.requests
            if r.method == "POST" and r.full_url.split("/rest/v1/")[1].split("?")[0] == table
        ]

    def bodies(self, table):
        return [json.loads(r.data.decode()) for r in self.writes(table)]


def _enable_supabase(monkeypatch):
    monkeypatch.setenv("USE_SUPABASE", "true")
    monkeypatch.setenv("SUPABASE_URL", "https://mock-project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")


def test_ingest_persists_to_supabase_when_enabled(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    _ingest({"user_id": "ingest-user", "record_type": "product", "rows": [PRODUCT]})
    response = _ingest({
        "user_id": "ingest-user", "record_type": "sales", "rows": _sales_rows(),
    })

    assert response.status_code == 200
    assert response.json()["durable"] is True
    assert response.json()["persisted_to"] == "sales"

    assert len(recorder.bodies("products")) == 1
    sales = recorder.bodies("sales")
    assert len(sales) == 1, "the sales batch should be a single request"
    assert len(sales[0]) == 3
    for row in sales[0]:
        assert row["user_id"] == "ingest-user"
    # Two batched audit requests total (one for the product, one for the whole
    # sales batch) -- not one per row.
    assert len(recorder.writes("audit_entries")) == 2
    actions = [
        entry["action"]
        for body in recorder.bodies("audit_entries")
        for entry in body
    ]
    assert actions == ["product_upserted"] + ["sales_upserted"] * 3


def test_failed_remote_write_surfaces_and_does_not_claim_success(monkeypatch):
    _enable_supabase(monkeypatch)
    monkeypatch.setattr("backend.supabase._urlopen", _Recorder(fail_on="sales"))

    _ingest({"user_id": "ingest-user", "record_type": "product", "rows": [PRODUCT]})
    response = _ingest({
        "user_id": "ingest-user", "record_type": "sales", "rows": _sales_rows(),
    })

    assert response.status_code == 503
    ws = v2._WORKSPACES["ingest-user"]
    assert ws.sales_records == {}
    assert not any(e.action == "sales_upserted" for e in ws.audit)


def test_failed_product_write_surfaces(monkeypatch):
    _enable_supabase(monkeypatch)
    monkeypatch.setattr("backend.supabase._urlopen", _Recorder(fail_on="products"))

    response = _ingest({
        "user_id": "ingest-user", "record_type": "product", "rows": [PRODUCT],
    })
    assert response.status_code == 503
    ws = v2._WORKSPACES.get("ingest-user")
    assert ws is None or ws.products == {}


# ---------------------------------------------------------------------------
# Batch audit adapter
# ---------------------------------------------------------------------------


def test_batch_audit_is_chunked(monkeypatch):
    from backend.supabase import append_audit_entries

    _enable_supabase(monkeypatch)
    monkeypatch.setenv("MAX_UPLOAD_ROWS", "10")
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    payloads = append_audit_entries("batch-user", [
        {
            "id": f"e{i}",
            "action": "sales_upserted",
            "product_id": "P1",
            "detail": {"i": i},
            "created_at": "2025-01-01T00:00:00+00:00",
        }
        for i in range(25)
    ])

    chunks = recorder.writes("audit_entries")
    assert len(chunks) == 3, "25 entries at 10 per chunk must be 3 requests"
    assert all(len(json.loads(c.data.decode())) <= 10 for c in chunks)
    assert sum(len(json.loads(c.data.decode())) for c in chunks) == 25
    assert len(payloads) == 25


def test_normal_size_batch_is_a_single_audit_request(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    ws = TenantWorkspace("batch-user")
    ws.add_product(PRODUCT)
    ws.upsert_sales_rows([
        {"product_id": "P1", "date": f"2025-06-{d:02d}", "units_sold": d}
        for d in range(1, 26)
    ])

    assert len(recorder.writes("sales")) == 1
    # One audit request for the product and one for the whole sales batch.
    assert len(recorder.writes("audit_entries")) == 2
    assert len(ws.audit) == 26


def test_batch_audit_refuses_duplicate_ids(monkeypatch):
    from backend.supabase import SupabasePersistenceError, append_audit_entries

    _enable_supabase(monkeypatch)
    monkeypatch.setattr(
        "backend.supabase._urlopen", lambda *_a, **_k: pytest.fail("no write expected")
    )
    entry = {
        "id": "same", "action": "forecast_generated", "product_id": "P1",
        "detail": {}, "created_at": "2025-01-01T00:00:00+00:00",
    }
    with pytest.raises(SupabasePersistenceError, match="duplicate entry id"):
        append_audit_entries("tenant-a", [entry, dict(entry)])


def test_empty_batch_audit_makes_no_request(monkeypatch):
    from backend.supabase import append_audit_entries

    _enable_supabase(monkeypatch)
    monkeypatch.setattr(
        "backend.supabase._urlopen", lambda *_a, **_k: pytest.fail("no write expected")
    )
    assert append_audit_entries("tenant-a", []) == []


def test_batch_product_ingest_uses_one_remote_call(monkeypatch):
    _enable_supabase(monkeypatch)
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    ws = TenantWorkspace("prod-user")
    ws.add_products([
        {"product_id": f"P{i}", "product_name": f"Item {i}", "current_stock": i}
        for i in range(1, 21)
    ])

    assert len(recorder.writes("products")) == 1
    assert len(recorder.bodies("products")[0]) == 20
    assert len(recorder.writes("audit_entries")) == 1
    assert len(ws.products) == 20


def test_duplicate_product_in_batch_is_refused(monkeypatch):
    _enable_supabase(monkeypatch)
    monkeypatch.setattr(
        "backend.supabase._urlopen", lambda *_a, **_k: pytest.fail("no write expected")
    )
    ws = TenantWorkspace("prod-user")
    with pytest.raises(ValueError, match="duplicate product_id"):
        ws.add_products([PRODUCT, dict(PRODUCT)])
    assert ws.products == {}
