"""Tests for the issuer-aware session routes: signup, login, refresh, me, logout.

Before Supabase sign-in existed, the session routes only served the local sqlite
issuer and answered 503 under ``USE_SUPABASE=true``. They are now issuer-aware,
which raises two things worth pinning down:

* A session must be established through whichever provider holds the account,
  and must never fall back from one to the other. Answering a Supabase login
  from a local database that happens to contain the same address would sign
  somebody into the wrong workspace.
* Establishing a session must not require a privileged credential. Sign-up,
  sign-in and refresh are public operations and may only carry the publishable
  key; only ``/admin/*`` calls may use the service-role key.

No test here reaches the network. Both Supabase transports are stubbed, so a
test cannot pass or fail depending on the machine's connectivity.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time

import pytest
from fastapi.testclient import TestClient

from backend import local_auth, supabase_auth
from backend.config import Settings
from backend.main import app
from tests.test_supabase_auth import (
    PUBLISHABLE,
    SERVICE_ROLE,
    _b64,
    _enable_supabase_auth,
    _GoTrue,
    _http_error,
    _install,
)

client = TestClient(app)

ACCESS = "supabase-access-token"
REFRESH = "supabase-refresh-token"
SIGNING_SECRET = "sessions-test-" + secrets.token_urlsafe(48)


@pytest.fixture(autouse=True)
def jwt_environment(monkeypatch):
    """HS256 with a test-only secret, no Supabase, no local issuer by default.

    Each module needs its own copy: a fixture defined in another test module
    does not apply here, and without this every ``me``/``logout`` test would fail
    on a 401 from the token check rather than on anything being tested.
    """

    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")
    monkeypatch.setenv("JWT_SECRET", SIGNING_SECRET)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "false")
    for key in (
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_ANON_KEY",
        "PASSWORD_RESET_REDIRECT_URL",
        "LOCAL_DATABASE_PATH",
        "LOCAL_AUTH_DATABASE_PATH",
    ):
        monkeypatch.delenv(key, raising=False)


def _token(subject: str, *, email: str | None = None) -> str:
    """A token signed with this module's secret."""

    now = time.time()
    payload = {"sub": subject, "iat": now, "exp": now + 3600}
    if email is not None:
        payload["email"] = email
    encoded_header = _b64({"alg": "HS256", "typ": "JWT"})
    encoded_payload = _b64(payload)
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
    signature = hmac.new(
        SIGNING_SECRET.encode("utf-8"), signing_input, hashlib.sha256
    ).digest()
    return (
        f"{encoded_header}.{encoded_payload}."
        f"{base64.urlsafe_b64encode(signature).rstrip(b'=').decode('ascii')}"
    )


def _auth_headers(subject: str = "auth-user", *, email: str | None = None) -> dict:
    return {"Authorization": f"Bearer {_token(subject, email=email)}"}


def _session(user_id: str = "sup-user-1", email: str = "person@example.com") -> dict:
    """A GoTrue ``grant_type=password`` success body."""

    return {
        "access_token": ACCESS,
        "refresh_token": REFRESH,
        "token_type": "bearer",
        "expires_in": 3600,
        "user": {
            "id": user_id,
            "email": email,
            "user_metadata": {"name": "Person", "business_name": "Acme"},
        },
    }


def _headers_of(request) -> dict:
    return {k.lower(): v for k, v in request.header_items()}


# ----------------------------------------------------------------- sign-in


def test_login_establishes_a_session_through_gotrue(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue(routes={"/token": _session()}))

    response = client.post(
        "/api/auth/login",
        json={"email": " Person@Example.com ", "password": "correct horse"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["access_token"] == ACCESS
    assert body["refresh_token"] == REFRESH
    assert body["token_type"] == "bearer"
    # The projected user keeps the names the frontend already consumes.
    assert body["user"] == {
        "id": "sup-user-1",
        "sub": "sup-user-1",
        "email": "person@example.com",
        "name": "Person",
        "businessName": "Acme",
    }

    request = gotrue.for_path("/token")[0]
    assert _GoTrue.body(request) == {
        "email": "person@example.com",
        "password": "correct horse",
    }


def test_login_never_attaches_the_service_role_key(monkeypatch):
    """Signing in is a public operation; a privileged key must not be used."""

    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue(routes={"/token": _session()}))

    client.post(
        "/api/auth/login", json={"email": "person@example.com", "password": "pw12345678"}
    )

    headers = _headers_of(gotrue.for_path("/token")[0])
    assert headers["apikey"] == PUBLISHABLE
    assert SERVICE_ROLE not in json.dumps(headers)
    assert SERVICE_ROLE not in gotrue.for_path("/token")[0].full_url


def test_login_failures_are_indistinguishable(monkeypatch):
    """An unknown address and a wrong password must be byte-identical."""

    _enable_supabase_auth(monkeypatch)
    unknown = _http_error(400, {"error_code": "invalid_credentials",
                                "msg": "Invalid login credentials"})
    wrong = _http_error(400, {"error_code": "invalid_credentials",
                              "msg": "Invalid login credentials"})

    replies = []
    for failure in (unknown, wrong):
        _install(monkeypatch, _GoTrue(default=failure))
        response = client.post(
            "/api/auth/login",
            json={"email": "person@example.com", "password": "whatever"},
        )
        replies.append((response.status_code, response.json()))

    assert replies[0] == replies[1] == (401, {"detail": "Email or password is incorrect."})


def test_login_does_not_leak_an_unconfirmed_account(monkeypatch):
    """A different upstream answer for an unconfirmed address is still one 401.

    A project with "Confirm email" enabled answers an unconfirmed address
    differently from an unknown one. Passing that difference through would be
    an account-existence oracle, so it is collapsed like every other failure.
    """

    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(default=_http_error(422, {"msg": "Email not confirmed"})),
    )

    response = client.post(
        "/api/auth/login", json={"email": "person@example.com", "password": "pw12345678"}
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Email or password is incorrect."}


def test_login_passes_a_rate_limit_through_as_a_rate_limit(monkeypatch):
    """A 429 is not a credential verdict and must not be hidden as one."""

    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(default=_http_error(429, {"msg": "Email rate limit exceeded"})),
    )

    response = client.post(
        "/api/auth/login", json={"email": "person@example.com", "password": "pw12345678"}
    )

    # The status is the point: a throttle reported as 401 would tell the user
    # their password is wrong and send them to reset it for no reason.
    assert response.status_code == 429
    assert response.json()["detail"] == "Email rate limit exceeded"


def test_login_reports_an_upstream_outage_as_unavailable(monkeypatch):
    """A 5xx is an upstream fault, not a statement about the caller's password."""

    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue(default=_http_error(503, None)))

    response = client.post(
        "/api/auth/login", json={"email": "person@example.com", "password": "pw12345678"}
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "Supabase Auth could not complete the request."


def test_login_never_reports_success_without_a_token(monkeypatch):
    """A 200 carrying no access token is not a session."""

    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue(routes={"/token": {"user": _session()["user"]}}))

    response = client.post(
        "/api/auth/login", json={"email": "person@example.com", "password": "pw12345678"}
    )

    assert response.status_code == 401
    assert "access_token" not in response.json()


def test_login_rejects_a_malformed_address_before_reaching_gotrue(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue(routes={"/token": _session()}))

    response = client.post(
        "/api/auth/login", json={"email": "not-an-address", "password": "pw12345678"}
    )

    assert response.status_code == 422
    assert gotrue.for_path("/token") == []


# ----------------------------------------------------------------- sign-up


def test_signup_returns_a_session_when_gotrue_issues_one(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue(routes={"/signup": _session()}))

    response = client.post(
        "/api/auth/signup",
        json={
            "email": "Person@Example.com",
            "password": "correct horse",
            "fullName": "Person",
            "businessName": "Acme",
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["access_token"] == ACCESS
    assert body["confirmation_required"] is False
    # Only the two validated profile fields become user_metadata. Nothing the
    # caller sent is echoed into GoTrue unfiltered.
    assert _GoTrue.body(gotrue.for_path("/signup")[0]) == {
        "email": "person@example.com",
        "password": "correct horse",
        "data": {"name": "Person", "business_name": "Acme"},
    }


def test_signup_omits_metadata_when_no_profile_was_given(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue(routes={"/signup": _session()}))

    response = client.post(
        "/api/auth/signup",
        json={"email": "person@example.com", "password": "correct horse"},
    )

    assert response.status_code == 201
    assert "data" not in _GoTrue.body(gotrue.for_path("/signup")[0])


def test_signup_reports_a_confirmation_requirement_honestly(monkeypatch):
    """With "Confirm email" on, GoTrue creates the account and issues no token.

    Returning a 201 with an empty ``access_token`` and saying so is the honest
    shape: the alternative -- pretending to be signed in -- would leave the
    browser storing an empty credential that fails on the first protected call.
    """

    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(
            routes={
                "/signup": {
                    "user": _session()["user"],
                    "confirmation_sent_at": "2026-01-01T00:00:00Z",
                }
            }
        ),
    )

    response = client.post(
        "/api/auth/signup",
        json={"email": "person@example.com", "password": "correct horse"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["confirmation_required"] is True
    assert body["access_token"] == ""
    assert body["refresh_token"] == ""
    assert body["user"]["id"] == "sup-user-1"


def test_signup_surfaces_a_duplicate_account(monkeypatch):
    """The local issuer answers 409 for a duplicate; Supabase has its own 422.

    Both disclose that the address is taken. That matches the pre-existing
    behaviour of this endpoint rather than newly leaking it, and at signup the
    address is one the caller has just typed.
    """

    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(default=_http_error(422, {"msg": "User already registered"})),
    )

    response = client.post(
        "/api/auth/signup",
        json={"email": "person@example.com", "password": "correct horse"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "User already registered"


# ------------------------------------------------------------------ refresh


def test_refresh_renews_the_access_token(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch,
        _GoTrue(routes={"/token": _session(user_id="sup-user-9")}),
    )

    response = client.post("/api/auth/refresh", json={"refreshToken": REFRESH})

    assert response.status_code == 200
    assert response.json()["access_token"] == ACCESS
    request = gotrue.for_path("/token")[0]
    assert "grant_type=refresh_token" in request.full_url
    assert _GoTrue.body(request) == {"refresh_token": REFRESH}
    # Renewing is a public operation too.
    assert _headers_of(request)["apikey"] == PUBLISHABLE


def test_refresh_rejects_an_unknown_or_revoked_token(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(default=_http_error(400, {"msg": "Invalid Refresh Token"})),
    )

    response = client.post("/api/auth/refresh", json={"refreshToken": "no-such-token"})

    assert response.status_code == 401
    # The upstream wording is not passed through, so a revoked token and an
    # unknown one cannot be told apart.
    assert "Invalid Refresh Token" not in response.text
    assert response.json() == {
        "detail": "This session is no longer valid. Please sign in again."
    }


def test_refresh_requires_a_non_empty_token(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue(routes={"/token": _session()}))

    response = client.post("/api/auth/refresh", json={"refreshToken": ""})

    assert response.status_code == 422
    assert gotrue.for_path("/token") == []


# ------------------------------------------------------------------------ me


def test_me_reads_the_account_behind_the_signed_subject(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch,
        _GoTrue(routes={"/admin/users": _session()["user"]}),
    )

    response = client.get(
        "/api/auth/me", headers=_auth_headers("sup-user-1", email="person@example.com")
    )

    assert response.status_code == 200
    assert response.json()["user"]["businessName"] == "Acme"
    # The id is the verified subject, and the admin credential is server-side.
    request = gotrue.for_path("/admin/users")[0]
    assert "/admin/users/sup-user-1" in request.full_url
    assert _headers_of(request)["apikey"] == SERVICE_ROLE


def test_me_ignores_a_caller_supplied_tenant(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch, _GoTrue(routes={"/admin/users": _session()["user"]})
    )

    response = client.get(
        "/api/auth/me?user_id=someone-else",
        headers=_auth_headers("sup-user-1"),
    )

    assert response.status_code == 200
    assert "someone-else" not in gotrue.for_path("/admin/users")[0].full_url


def test_me_requires_a_bearer_token_under_supabase(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue())

    assert client.get("/api/auth/me").status_code == 401


# -------------------------------------------------------------------- logout


def test_logout_revokes_with_the_refresh_token_when_the_caller_has_one(monkeypatch):
    """Both credentials are sent, and each does a different job.

    The access token authorizes the call -- GoTrue answers a body-only request
    with ``401 no_authorization`` and revokes nothing -- and the refresh token
    names the exact session to destroy rather than whichever one the bearer
    happens to map to. Verified against the live project, where a body-only
    logout left the refresh token working.
    """

    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())
    token = _token("sup-user-1")

    response = client.post(
        "/api/auth/logout",
        headers={"Authorization": f"Bearer {token}"},
        json={"refreshToken": REFRESH},
    )

    assert response.status_code == 200
    call = gotrue.for_path("/logout")[0]
    assert call.get_method() == "POST"
    assert _GoTrue.body(call) == {"refresh_token": REFRESH}
    headers = _headers_of(call)
    assert headers["authorization"] == f"Bearer {token}"
    # Revocation is a public operation, so it must not demand a privileged
    # credential to be usable.
    assert headers["apikey"] == PUBLISHABLE


def test_logout_falls_back_to_the_bearer_without_a_refresh_token(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())
    token = _token("sup-user-1")

    response = client.post(
        "/api/auth/logout", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 200
    call = gotrue.for_path("/logout")[0]
    assert _headers_of(call)["authorization"] == f"Bearer {token}"


def test_logout_reports_a_failed_revocation_instead_of_swallowing_it(
    monkeypatch, caplog
):
    """200 is right -- the caller is signed out -- but not silently.

    A 5xx leaves it unknown whether the refresh token is still live, so an
    operator has to be able to see that from the logs. Reporting plain success
    would be a security-relevant lie about whether the session was revoked.
    """

    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue(default=_http_error(500, None)))

    with caplog.at_level(logging.WARNING, logger="backend.routers.auth"):
        response = client.post("/api/auth/logout", headers=_auth_headers("sup-user-1"))

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert any(
        "could not confirm a sign-out revocation" in record.message
        for record in caplog.records
    ), [r.message for r in caplog.records]


def test_logout_does_not_raise_an_alarm_when_there_was_nothing_to_revoke(
    monkeypatch, caplog
):
    """A 4xx means GoTrue found no session -- which is the goal, not a problem.

    This is the normal answer right after a password change, because changing
    the password revokes the session itself. Warning about it made every
    password change look like a security incident, and an operator who learns to
    ignore that line would also ignore a real one.
    """

    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue(default=_http_error(403, None)))

    with caplog.at_level(logging.INFO, logger="backend.routers.auth"):
        response = client.post("/api/auth/logout", headers=_auth_headers("sup-user-1"))

    assert response.status_code == 200
    levels = {r.levelno for r in caplog.records}
    assert logging.WARNING not in levels, [r.message for r in caplog.records]
    assert any(
        "no live session to revoke" in r.message for r in caplog.records
    ), [r.message for r in caplog.records]


def test_logout_all_still_forwards_the_caller_token(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())
    token = _token("sup-user-1")

    response = client.post(
        "/api/auth/logout-all", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 200
    call = gotrue.for_path("/logout")[0]
    assert "scope=others" in call.full_url
    assert _headers_of(call)["authorization"] == f"Bearer {token}"


# ------------------------------------------------------- the local issuer path


def test_local_issuer_still_works_and_advertises_no_refresh_token(
    tmp_path, monkeypatch
):
    """The local issuer's envelope gains an empty refresh token, not a fake one."""

    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "true")
    monkeypatch.setenv(
        "LOCAL_AUTH_DATABASE_PATH", str(tmp_path / "local-auth.sqlite3")
    )
    monkeypatch.setenv("LOCAL_DATABASE_PATH", str(tmp_path / "local.sqlite3"))
    local_auth.reset_store()
    try:
        signup = client.post(
            "/api/auth/signup",
            json={
                "email": "local@example.com",
                "password": "local-password",
                "fullName": "Local User",
            },
        )
        assert signup.status_code == 201, signup.text
        body = signup.json()
        assert body["access_token"]
        assert body["refresh_token"] == ""
        assert body["confirmation_required"] is False
        assert body["user"]["name"] == "Local User"

        login = client.post(
            "/api/auth/login",
            json={"email": "local@example.com", "password": "local-password"},
        )
        assert login.status_code == 200
        assert login.json()["user"]["id"] == body["user"]["id"]
        assert login.json()["refresh_token"] == ""

        me = client.get(
            "/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"}
        )
        assert me.status_code == 200
        assert me.json()["user"]["email"] == "local@example.com"

        # Signing out does not need a provider that can be revoked.
        out = client.post(
            "/api/auth/logout",
            headers={"Authorization": f"Bearer {body['access_token']}"},
        )
        assert out.status_code == 200
    finally:
        local_auth.reset_store()


def test_the_two_issuers_cannot_both_be_enabled(monkeypatch):
    """The routing decision has no tie to break, by construction."""

    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "true")
    monkeypatch.setenv("USE_SUPABASE", "true")
    monkeypatch.setenv("SUPABASE_URL", "https://mock-project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", PUBLISHABLE)

    with pytest.raises(RuntimeError, match="LOCAL_AUTH_ENABLED is not allowed"):
        Settings()


def test_a_local_only_deployment_never_dials_supabase(tmp_path, monkeypatch):
    """No fallback in either direction: no Supabase call with no project."""

    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "true")
    monkeypatch.setenv(
        "LOCAL_AUTH_DATABASE_PATH", str(tmp_path / "local-auth.sqlite3")
    )
    monkeypatch.setenv("LOCAL_DATABASE_PATH", str(tmp_path / "local.sqlite3"))
    for key in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
                "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"):
        monkeypatch.delenv(key, raising=False)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("the local issuer must not call Supabase Auth")

    monkeypatch.setattr(supabase_auth, "_urlopen", forbidden)
    local_auth.reset_store()
    try:
        client.post(
            "/api/auth/login",
            json={"email": "nobody@example.com", "password": "wrong-password"},
        )
    finally:
        local_auth.reset_store()
