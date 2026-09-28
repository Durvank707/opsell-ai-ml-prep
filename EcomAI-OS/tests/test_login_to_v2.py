"""A login that has just succeeded can call the V2 API immediately.

Regression test for a live incident in which ``POST /api/auth/login`` answered
200 but the first ``/api/v2/...`` call afterwards failed (a 503 reading
"Authentication is not configured on the server." alongside a browser-side
headerless 401 "Authentication is required.").

Whatever the browser did, the invariant pinned down here is exact and runs
against the real back end: the access token a *fresh* login hands out is
accepted by a V2 route on the very next request — no warm-up call, no re-login,
no second session. The negative cases are held as well so the happy path is
never "fixed" by weakening authentication: a missing bearer is still refused
with the canonical 401, and a token is still refused for another tenant.

Hermetic by construction (like the rest of the suite): local HS256 issuer,
throwaway account store, no Supabase, no ambient credentials.
"""

from __future__ import annotations

import secrets

import pytest
from fastapi.testclient import TestClient

from backend.main import app


SECRET = "test-" + secrets.token_urlsafe(48)
PASSWORD = "correct-horse-123"
client = TestClient(app)


@pytest.fixture(autouse=True)
def login_environment(monkeypatch, tmp_path):
    # The local issuer is opt-in, mutually exclusive with Supabase, and must
    # point at a database that is not the developer's real one.
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    monkeypatch.delenv("JWT_ISSUER", raising=False)
    monkeypatch.delenv("JWT_AUDIENCE", raising=False)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "true")
    monkeypatch.setenv("LOCAL_AUTH_DATABASE_PATH", str(tmp_path / "auth.sqlite3"))
    monkeypatch.setenv("LOCAL_DATABASE_PATH", str(tmp_path / "tenant.sqlite3"))


def _signup(email: str) -> dict:
    response = client.post(
        "/api/auth/signup",
        json={
            "fullName": "New User",
            "businessName": "New Store",
            "email": email,
            "password": PASSWORD,
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    # A brand-new account is handed a live session immediately (no "Confirm
    # email" flow in the local issuer), so the next call already has a token.
    assert body["access_token"], "a brand-new account must receive a session"
    assert body["confirmation_required"] is False
    return body


def _login(email: str) -> dict:
    response = client.post(
        "/api/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["access_token"]
    return body


def test_newly_logged_in_user_can_immediately_call_v2_sales_summary():
    """Login hands out a token that the very next V2 request accepts."""
    account = _signup("fresh-tenant@example.com")
    user_id = account["user"]["id"]

    login = _login("fresh-tenant@example.com")

    # This is the first authenticated request after the login.
    response = client.get(
        "/api/v2/sales/summary",
        params={"user_id": user_id},
        headers={"Authorization": f"Bearer {login['access_token']}"},
    )

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["total_records"] == 0  # a fresh tenant is empty, not broken
    assert {
        "total_records",
        "total_units",
        "total_revenue",
        "products_covered",
        "date_from",
        "date_to",
        "channels",
        "unrecorded",
        "available_channels",
    } <= set(data)


def test_immediately_after_login_a_request_without_bearer_is_still_401():
    """A session does not excuse a request that omitted its credential."""
    account = _signup("missing-bearer@example.com")
    user_id = account["user"]["id"]
    _login("missing-bearer@example.com")

    response = client.get("/api/v2/sales/summary", params={"user_id": user_id})

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication is required."}
    assert response.headers["www-authenticate"] == "Bearer"


def test_immediately_after_login_a_token_cannot_enter_another_tenant():
    """Login does not widen the caller's reach to another tenant's data."""
    account_a = _signup("tenant-a@example.com")
    _signup("tenant-b@example.com")
    login_b = _login("tenant-b@example.com")

    response = client.get(
        "/api/v2/sales/summary",
        params={"user_id": account_a["user"]["id"]},
        headers={"Authorization": f"Bearer {login_b['access_token']}"},
    )

    assert response.status_code == 403
    assert response.json() == {
        "detail": "Authenticated identity does not match the requested tenant."
    }