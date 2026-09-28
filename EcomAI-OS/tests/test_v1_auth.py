"""Hardening tests for the V1 surface: authentication is now mandatory.

V1 is the legacy, global catalog service (not tenant-isolated by design). After
hardening, every V1 endpoint must return ``401`` without a valid JWT, accept a
valid JWT for normal use, and remain fully behind the same verified identity as
V2. Tenant isolation itself lives in V2 (``resolve_tenant_id``) and must not be
weakened; those cross-tenant checks are exercised here too so a future V1
change cannot regress them.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient

from backend.auth import require_v1_auth
from backend.main import app
from backend.tenant import DEMO_EMAIL, DEMO_USER_ID

# Mirrors the hermetic HS256 baseline in tests/conftest.py.
SECRET = "test-only-not-a-real-secret-" + "0" * 32
client = TestClient(app)

# (method, path, kwargs) for every V1 route that carries require_v1_auth.
# Bodies are valid so an unauthenticated call can only fail with 401, never a
# validation 422.
V1_CASES = [
    ("get", "/api/products", {}),
    ("get", "/api/products/P001", {}),
    ("post", "/api/forecast", {"json": {"product_id": "P001", "horizon": 14}}),
    ("get", "/api/inventory/overview", {}),
    (
        "get",
        "/api/inventory/reorder/P001",
        {"params": {"moq": 50, "pack_size": 12}},
    ),
    (
        "post",
        "/api/inventory/reorder/calculate",
        {"json": {"product_id": "P001", "moq": 50, "pack_size": 12}},
    ),
    ("get", "/api/inventory/timeline/P001", {}),
    ("post", "/api/simulation/backtest", {"json": {"product_id": "P001"}}),
]


@pytest.fixture(autouse=True)
def v1_hardening_env(monkeypatch):
    """Explicit environment so this module is self-contained and fail-closed."""

    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "false")
    monkeypatch.setenv("V1_ENABLED", "true")
    monkeypatch.setenv("V1_REQUIRE_AUTH", "true")


def _b64(value: dict) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()


def _token(subject: str, *, email: str | None = None, exp: float | None = None) -> str:
    now = time.time()
    payload = {"sub": subject, "iat": now, "exp": exp if exp is not None else now + 3600}
    if email is not None:
        payload["email"] = email
    header = _b64({"alg": "HS256", "typ": "JWT"})
    body = _b64(payload)
    sig = hmac.new(
        SECRET.encode(), f"{header}.{body}".encode(), hashlib.sha256
    ).digest()
    return f"{header}.{body}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


def _headers(subject: str = "user-a") -> dict:
    return {"Authorization": f"Bearer {_token(subject)}"}


# --------------------------------------------------------------- gate behavior


def test_every_v1_endpoint_returns_401_without_credentials():
    for method, path, kwargs in V1_CASES:
        response = getattr(client, method)(path, **kwargs)
        assert response.status_code == 401, (method, path, response.text)
        assert response.headers["www-authenticate"] == "Bearer", path


def test_every_v1_endpoint_accepts_a_valid_token():
    for method, path, kwargs in V1_CASES:
        response = getattr(client, method)(path, headers=_headers(), **kwargs)
        assert response.status_code == 200, (method, path, response.text)
        if path in ("/api/products/P001", "/api/forecast"):
            assert response.json()["product_id"] == "P001"


def test_v1_rejects_garbage_expired_and_wrongly_signed_tokens():
    for token in (
        "not.a.jwt",
        _token("user-a", exp=time.time() - 100),  # expired
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4In0." + "A" * 40,  # forged
    ):
        response = client.get(
            "/api/products", headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 401, token
        assert response.headers["www-authenticate"] == "Bearer"


def test_v1_rejects_non_bearer_schemes():
    response = client.get(
        "/api/products", headers={"Authorization": "Basic dXNlcjpwYXNz"}
    )
    assert response.status_code == 401


def test_v1_dependency_returns_only_the_verified_identity():
    principal = require_v1_auth(
        HTTPAuthorizationCredentials(scheme="Bearer", credentials=_token("alice"))
    )
    assert principal is not None
    assert principal.authenticated is True
    assert principal.user_id == "alice"

    # A bad token is converted to the same 401 the HTTP layer returns.
    with pytest.raises(HTTPException) as exc_info:
        require_v1_auth(
            HTTPAuthorizationCredentials(
                scheme="Bearer",
                credentials=_token("alice", exp=time.time() - 100),
            )
        )
    assert exc_info.value.status_code == 401
    assert exc_info.value.headers == {"WWW-Authenticate": "Bearer"}


# ---------------------------------------------------------- tenant isolation


def test_v2_cross_tenant_substitution_stays_rejected():
    token = _token("user-a")
    response = client.get(
        "/api/v2/overview/user-b",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403, response.text


def test_v2_is_still_fail_closed_unauthenticated():
    response = client.get("/api/v2/overview/user-a")
    assert response.status_code == 401


def test_v2_authenticated_same_tenant_access_is_unaffected():
    response = client.get("/api/v2/overview/user-a", headers=_headers("user-a"))
    assert response.status_code == 200, response.text
    assert response.json()["user_id"] == "user-a"


# ----------------------------------------------------------- demo & liveness


def test_a_demo_session_token_can_use_v1():
    token = _token(DEMO_USER_ID, email=DEMO_EMAIL)
    for method, path, kwargs in V1_CASES:
        response = getattr(client, method)(path, headers={"Authorization": f"Bearer {token}"}, **kwargs)
        assert response.status_code == 200, (method, path, response.text)


def test_health_liveness_check_stays_public():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


# ------------------------------------------------------ disabled-surface path


def test_disabled_v1_returns_404_even_with_valid_credentials(monkeypatch):
    monkeypatch.setenv("V1_ENABLED", "false")
    # No credentials: the disabled check runs first, so nothing is revealed.
    for method, path, kwargs in V1_CASES:
        response = getattr(client, method)(path, **kwargs)
        assert response.status_code == 404, (method, path, response.text)
    # Valid credentials cannot re-enable the surface either.
    for method, path, kwargs in V1_CASES:
        response = getattr(client, method)(path, headers=_headers(), **kwargs)
        assert response.status_code == 404, (method, path, response.text)
    # V2 -- the tenant-scoped surface -- is unaffected by the V1 flag.
    response = client.get("/api/v2/overview/user-a", headers=_headers("user-a"))
    assert response.status_code == 200