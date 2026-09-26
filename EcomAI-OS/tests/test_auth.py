"""Regression tests for V2 JWT authentication and tenant binding."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routers import v2


SECRET = "test-" + secrets.token_urlsafe(48)
client = TestClient(app)


def _b64(value: dict) -> str:
    encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode("ascii")


def _token(
    subject: str = "auth-user-a",
    *,
    expires_at: float | None = None,
    header: dict | None = None,
    claims: dict | None = None,
    secret: str = SECRET,
) -> str:
    now = time.time()
    header_value = {"alg": "HS256", "typ": "JWT"}
    if header is not None:
        header_value = header
    payload = {
        "sub": subject,
        "iat": now,
        "exp": now + 3600 if expires_at is None else expires_at,
    }
    if claims:
        payload.update(claims)
    encoded_header = _b64(header_value)
    encoded_payload = _b64(payload)
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
    signature = hmac.new(
        secret.encode("utf-8"), signing_input, hashlib.sha256
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{encoded_header}.{encoded_payload}.{encoded_signature}"


@pytest.fixture(autouse=True)
def jwt_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    monkeypatch.delenv("JWT_ISSUER", raising=False)
    monkeypatch.delenv("JWT_AUDIENCE", raising=False)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")


def test_v2_requires_a_bearer_token():
    response = client.get("/api/v2/overview/auth-user-a")

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication is required."}
    assert response.headers["www-authenticate"] == "Bearer"


def test_valid_token_binds_the_path_tenant_to_the_subject():
    token = _token("auth-user-a")

    response = client.get(
        "/api/v2/overview/auth-user-a",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["user_id"] == "auth-user-a"
    assert "auth-user-b" not in v2._WORKSPACES or not v2._WORKSPACES[
        "auth-user-b"
    ].products


def test_valid_token_cannot_select_another_tenant_path():
    token = _token("auth-user-a")

    response = client.get(
        "/api/v2/overview/auth-user-b",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 403
    assert response.json() == {
        "detail": "Authenticated identity does not match the requested tenant."
    }
    assert "auth-user-b" not in v2._WORKSPACES


def test_body_user_id_cannot_override_the_token_subject():
    token = _token("auth-user-a")
    payload = {"user_id": "auth-user-b", "rows": []}

    response = client.post(
        "/api/v2/validate",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 403
    assert "requested tenant" in response.json()["detail"]


def test_matching_token_can_use_v2_validation():
    token = _token("auth-user-a")
    payload = {"user_id": "auth-user-a", "rows": []}

    response = client.post(
        "/api/v2/validate",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert response.json()["accepted_rows"] == 0


def test_signature_alg_and_expiry_failures_are_rejected():
    invalid_signature = _token("auth-user-a", secret=SECRET + "-wrong")
    expired = _token("auth-user-a", expires_at=time.time() - 60)
    none_algorithm = _token(
        "auth-user-a",
        header={"alg": "none", "typ": "JWT"},
    )

    for token in (invalid_signature, expired, none_algorithm):
        response = client.get(
            "/api/v2/overview/auth-user-a",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 401
        assert response.json() == {"detail": "Invalid authentication token."}


def test_token_subject_and_tenant_claim_must_match(monkeypatch):
    token = _token(
        "auth-user-a",
        claims={"user_id": "auth-user-b"},
    )
    # The default claim is `sub`; the extra claim is harmless, so this token is
    # valid. A server configured with `user_id` must reject a mismatch.
    response = client.get(
        "/api/v2/overview/auth-user-a",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200

    monkeypatch.setenv("JWT_USER_ID_CLAIM", "user_id")
    response = client.get(
        "/api/v2/overview/auth-user-a",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401


def test_missing_server_secret_fails_closed(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)

    response = client.get("/api/v2/overview/auth-user-a")

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Authentication is not configured on the server."
    }


def test_job_owner_is_bound_to_the_verified_subject():
    token = _token("auth-user-a")
    headers = {"Authorization": f"Bearer {token}"}

    created = client.post(
        "/api/v2/jobs?user_id=auth-user-a&job_type=simulation",
        headers=headers,
    )
    assert created.status_code == 202
    job_id = created.json()["job_id"]

    own_status = client.get(
        f"/api/v2/jobs/{job_id}?user_id=auth-user-a",
        headers=headers,
    )
    assert own_status.status_code == 200
    assert own_status.json()["user_id"] == "auth-user-a"

    other_token = _token("auth-user-b")
    other_status = client.get(
        f"/api/v2/jobs/{job_id}?user_id=auth-user-b",
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert other_status.status_code == 403
    assert other_status.json() == {"detail": "That job belongs to another user."}


def test_disabled_auth_is_only_an_explicit_local_mode(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "disabled")

    response = client.get("/api/v2/overview/local-auth-user")

    assert response.status_code == 200
    assert response.json()["user_id"] == "local-auth-user"


def test_disabled_auth_is_rejected_in_production(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "disabled")
    monkeypatch.setenv("APP_ENV", "production")

    response = client.get("/api/v2/overview/local-auth-user")

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Authentication is not configured on the server."
    }
