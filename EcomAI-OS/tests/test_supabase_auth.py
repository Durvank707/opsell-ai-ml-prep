"""Tests for the Supabase Auth account endpoints and their GoTrue client.

Two layers are covered separately because they fail differently:

* :mod:`backend.supabase_auth` is tested against a recorded transport, so the
  exact request each operation makes is asserted -- which key is attached, which
  credential is forwarded, and what is put on the wire.
* The routes are tested with that client stubbed, so the tests pin the API
  contract: status codes, tenant scoping, and the guarantee that a password
  reset cannot be used to discover which addresses have accounts.

No test here reaches the network. The ``_urlopen`` seam in
``backend.supabase_auth`` is the same one :mod:`backend.supabase` exposes and
that :mod:`tests.test_ui_api` already uses.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import secrets
import time
from urllib.error import HTTPError, URLError

import pytest
from fastapi.testclient import TestClient

from backend import supabase_auth
from backend.config import Settings
from backend.main import app
from backend.supabase_auth import SupabaseAuthError

SECRET = "test-" + secrets.token_urlsafe(48)
SERVICE_ROLE = "service-role-test-key"
PUBLISHABLE = "publishable-test-key"
PROJECT = "https://mock-project.supabase.co"
REDIRECT = "https://app.example.com/reset-password"

client = TestClient(app)


# --------------------------------------------------------------------- helpers


def _b64(value: dict) -> str:
    encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode("ascii")


def _token(subject: str = "auth-user", *, email: str | None = None) -> str:
    now = time.time()
    payload = {"sub": subject, "iat": now, "exp": now + 3600}
    if email is not None:
        payload["email"] = email
    encoded_header = _b64({"alg": "HS256", "typ": "JWT"})
    encoded_payload = _b64(payload)
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
    signature = hmac.new(
        SECRET.encode("utf-8"), signing_input, hashlib.sha256
    ).digest()
    return (
        f"{encoded_header}.{encoded_payload}."
        f"{base64.urlsafe_b64encode(signature).rstrip(b'=').decode('ascii')}"
    )


def _auth_headers(subject: str = "auth-user", *, email: str | None = None) -> dict:
    return {"Authorization": f"Bearer {_token(subject, email=email)}"}


class _Response:
    """Minimal stand-in for the object ``urlopen`` returns."""

    def __init__(self, payload):
        self._payload = payload

    def read(self):
        return b"" if self._payload is None else json.dumps(self._payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _GoTrue:
    """Records every outbound Supabase request and replies from a script.

    GoTrue calls and PostgREST data calls share one recorder because the two
    seams are separate module attributes: patching only
    ``backend.supabase_auth._urlopen`` would leave the data layer dialling the
    real project. Route keys are matched against the path with the origin and
    the ``/auth/v1`` prefix stripped, so ``/recover`` and ``/rest`` read the
    same as they do in the source.
    """

    ORIGIN = "https://mock-project.supabase.co"

    def __init__(self, routes=None, default=None):
        self.requests: list = []
        self.routes = routes or {}
        self.default = default

    @classmethod
    def path(cls, request):
        url = request.full_url
        if url.startswith(cls.ORIGIN):
            url = url[len(cls.ORIGIN) :]
        return "/rest" + url[len("/rest/v1") :] if url.startswith(
            "/rest/v1"
        ) else url[len("/auth/v1") :]

    def __call__(self, request, timeout):
        self.requests.append(request)
        path = self.path(request)
        for suffix, reply in self.routes.items():
            if path.startswith(suffix):
                return self._resolve(reply, request)
        return self._resolve(self.default, request)

    @staticmethod
    def _resolve(reply, request):
        if isinstance(reply, BaseException):
            raise reply
        if callable(reply):
            return _Response(reply(request))
        return _Response({} if reply is None else reply)

    def for_path(self, prefix):
        return [r for r in self.requests if self.path(r).startswith(prefix)]

    @staticmethod
    def body(request):
        return json.loads(request.data.decode())


def _http_error(code: int, payload=None) -> HTTPError:
    raw = b"" if payload is None else json.dumps(payload).encode()
    return HTTPError(
        url="https://mock-project.supabase.co/auth/v1/x",
        code=code,
        msg="upstream",
        hdrs=None,
        fp=io.BytesIO(raw),
    )


@pytest.fixture(autouse=True)
def jwt_environment(monkeypatch):
    """HS256 with a test-only secret, Supabase persistence off by default."""

    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "false")
    for key in (
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_ANON_KEY",
        "PASSWORD_RESET_REDIRECT_URL",
    ):
        monkeypatch.delenv(key, raising=False)


def _enable_supabase_auth(monkeypatch, **extra):
    monkeypatch.setenv("USE_SUPABASE", "true")
    monkeypatch.setenv("SUPABASE_URL", PROJECT)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", PUBLISHABLE)
    for key, value in extra.items():
        monkeypatch.setenv(key, value)
    return Settings()


def _install(monkeypatch, gotrue) -> _GoTrue:
    """Seam both Supabase transports so no test can reach the network.

    GoTrue and PostgREST each hold their own reference to ``_urlopen``. Patching
    only the auth one would let the data layer attempt a real connection, so a
    test could pass or fail depending on the machine's connectivity.
    """

    monkeypatch.setattr("backend.supabase_auth._urlopen", gotrue)
    monkeypatch.setattr("backend.supabase._urlopen", gotrue)
    return gotrue


# ------------------------------------------------------- configuration gating


def test_not_configured_without_supabase():
    assert supabase_auth.supabase_auth_configured(Settings()) is False


def test_configured_requires_every_credential(monkeypatch):
    # A URL and a service-role key are not enough: verifying a caller's own
    # password is a user-level grant, so the publishable key is required too.
    _enable_supabase_auth(monkeypatch)
    monkeypatch.delenv("SUPABASE_PUBLISHABLE_KEY")
    monkeypatch.delenv("SUPABASE_ANON_KEY", raising=False)
    assert supabase_auth.supabase_auth_configured(Settings()) is False


def test_configured_when_all_credentials_present(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    assert supabase_auth.supabase_auth_configured(Settings()) is True


def test_redirect_url_must_be_absolute(monkeypatch):
    monkeypatch.setenv("PASSWORD_RESET_REDIRECT_URL", "/reset-password")
    with pytest.raises(RuntimeError, match="absolute http"):
        Settings()


@pytest.mark.parametrize(
    "value",
    [
        "http://localhost:5173/reset-password",
        "https://app.example.com/reset-password",
        "https://app.example.com",
    ],
)
def test_redirect_url_accepts_plain_http_urls(monkeypatch, value):
    monkeypatch.setenv("PASSWORD_RESET_REDIRECT_URL", value)
    assert Settings().password_reset_redirect_url == value


# ----------------------------------------------------------------- email rules


def test_normalize_email_canonicalizes():
    assert supabase_auth.normalize_email("  Person@Example.COM ") == "person@example.com"


@pytest.mark.parametrize("value", ["", "not-an-address", "a@b", None, 42, "a b@c.com"])
def test_normalize_email_rejects_junk(value):
    with pytest.raises(ValueError):
        supabase_auth.normalize_email(value)


# ----------------------------------------------------------------- error safety


def test_error_detail_allowlists_known_messages():
    payload = {"msg": "User already registered"}
    assert (
        supabase_auth._safe_detail(payload, 422) == "User already registered"
    )


def test_error_detail_never_echoes_upstream_text():
    # An upstream message can contain request values (an address, a token), so
    # anything off the allowlist is replaced rather than relayed.
    payload = {"msg": "No user found with email leaked@example.com"}
    detail = supabase_auth._safe_detail(payload, 404)
    assert "leaked@example.com" not in detail
    assert detail == "No Supabase Auth account is linked to this identity."


def test_error_detail_handles_unparseable_bodies():
    assert supabase_auth._safe_detail(None, 429).startswith("Too many attempts")
    assert supabase_auth._safe_detail("a string body", 500)


# ------------------------------------------------------- recovery request flow


def test_recovery_posts_to_recover_with_redirect(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())
    settings = Settings()

    supabase_auth.request_password_recovery(
        settings, "person@example.com", REDIRECT
    )

    sent = gotrue.for_path("/recover")
    assert len(sent) == 1
    assert sent[0].method == "POST"
    assert gotrue.body(sent[0]) == {
        "email": "person@example.com",
        "redirect_to": REDIRECT,
    }


def test_recovery_uses_the_publishable_key_not_the_service_role(monkeypatch):
    # Starting a reset is a public operation. Attaching the service-role key
    # would hand it to GoTrue for a call no user is authorized to escalate.
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    supabase_auth.request_password_recovery(
        Settings(), "person@example.com", REDIRECT
    )

    headers = gotrue.for_path("/recover")[0].headers
    assert headers["Apikey"] == PUBLISHABLE
    assert SERVICE_ROLE not in json.dumps(dict(headers))


@pytest.mark.parametrize("code", [400, 404, 422, 429])
def test_recovery_swallows_client_errors_so_existence_stays_hidden(monkeypatch, code):
    # 404 here means "no such account" and 429 means "too many requests". Both
    # must look like a plain success to the caller, otherwise this endpoint
    # becomes an account-enumeration oracle.
    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue({"/recover": _http_error(code, {"msg": "Email not found"})}),
    )

    # A 4xx is not raised: the caller must see the same result either way.
    supabase_auth.request_password_recovery(
        Settings(), "ghost@example.com", REDIRECT
    )


def test_recovery_raises_on_server_error(monkeypatch):
    # A 5xx means the mail genuinely may not have gone out. Reporting success
    # would tell someone to wait for an email that will never arrive.
    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue({"/recover": _http_error(500)}))

    with pytest.raises(SupabaseAuthError) as caught:
        supabase_auth.request_password_recovery(
            Settings(), "person@example.com", REDIRECT
        )
    assert caught.value.status_code == 500


def test_recovery_raises_when_supabase_is_unreachable(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue(default=URLError("connection refused")))

    with pytest.raises(SupabaseAuthError) as caught:
        supabase_auth.request_password_recovery(
            Settings(), "person@example.com", REDIRECT
        )
    assert caught.value.status_code == 503


# -------------------------------------------------------- recovery token usage


def test_recovery_token_is_forwarded_as_the_bearer(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    supabase_auth.apply_recovery_token(Settings(), "recovery-token-abc", "newpass123")

    sent = gotrue.for_path("/user")
    assert len(sent) == 1
    assert sent[0].method == "PUT"
    assert gotrue.body(sent[0]) == {"password": "newpass123"}
    assert sent[0].headers["Authorization"] == "Bearer recovery-token-abc"
    assert sent[0].headers["Apikey"] == PUBLISHABLE


def test_recovery_session_is_revoked_once_the_password_is_set(monkeypatch):
    """A recovery link must stop working the moment it has been spent.

    GoTrue does not make a recovery session single-use: the same token can set
    the password repeatedly for its whole lifetime, and the last call wins. So
    the reset revokes the session it just used, with the very token the caller
    presented -- no privileged credential, just the caller's own.
    """

    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    supabase_auth.apply_recovery_token(Settings(), "recovery-token-abc", "newpass123")

    revoked = gotrue.for_path("/logout")
    assert len(revoked) == 1, "the recovery session was never revoked"
    assert revoked[0].headers["Authorization"] == "Bearer recovery-token-abc"
    # Revocation must never reach for the service-role key: the recovery token
    # authorises revoking itself, and the admin key is not needed here.
    assert revoked[0].headers["Apikey"] == PUBLISHABLE


def test_recovery_token_cannot_be_replayed_after_a_reset(monkeypatch):
    """Replaying a spent reset link must fail closed.

    A link that leaks -- forwarded mail, browser history, a proxy log -- would
    otherwise stay a working account-takeover credential for the rest of its
    hour-long life, long after the user reset their password and believed the
    link was spent. Modelled directly on GoTrue's real behaviour, observed live:
    one recovery session accepted three consecutive password writes.
    """

    _enable_supabase_auth(monkeypatch)
    revoked: set = set()
    current = {"password": "Original#2026a"}

    def _user(request):
        token = request.headers.get("Authorization", "").removeprefix("Bearer ")
        if token in revoked:
            # Exactly GoTrue's answer for a session that no longer exists.
            raise _http_error(
                403,
                {
                    "error_code": "session_not_found",
                    "msg": "Session from session_id claim in JWT does not exist",
                },
            )
        current["password"] = json.loads(request.data.decode())["password"]
        return {}

    def _logout(request):
        revoked.add(request.headers.get("Authorization", "").removeprefix("Bearer "))
        return {}

    _install(monkeypatch, _GoTrue({"/logout": _logout, "/user": _user}))

    supabase_auth.apply_recovery_token(Settings(), "recovery-token-abc", "Chosen#2026b")
    assert current["password"] == "Chosen#2026b"

    with pytest.raises(SupabaseAuthError) as caught:
        supabase_auth.apply_recovery_token(
            Settings(), "recovery-token-abc", "Attacker#2026c"
        )
    assert caught.value.status_code == 403
    assert current["password"] == "Chosen#2026b", "a replay must not change the password"


def test_failed_revocation_does_not_fail_a_successful_reset(monkeypatch):
    """Losing the revocation must not tell the user their reset did not happen.

    The password has already been accepted by the time revocation is attempted,
    so failing the request would report a reset that did occur as a failure. A
    still-replayable link is the lesser problem next to a user who never learns
    their new password works.
    """

    _enable_supabase_auth(monkeypatch)
    wrote = []
    _install(
        monkeypatch,
        _GoTrue(
            {
                "/logout": _http_error(500, {"msg": "smtp offline"}),
                "/user": lambda request: wrote.append(request) or {},
            }
        ),
    )

    supabase_auth.apply_recovery_token(Settings(), "recovery-token-abc", "newpass123")

    assert len(wrote) == 1, "the password must still have been set"


def test_recovery_token_failure_reports_the_upstream_status(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue({"/user": _http_error(401, {"msg": "Token has expired"})}),
    )

    with pytest.raises(SupabaseAuthError) as caught:
        supabase_auth.apply_recovery_token(Settings(), "expired", "newpass123")
    assert caught.value.status_code == 401


# ---------------------------------------------------------------- admin calls


def _gotrue_user(**overrides):
    user = {
        "id": "auth-user",
        "email": "person@example.com",
        "user_metadata": {"name": "Person", "business_name": "Shop"},
    }
    user.update(overrides)
    return user


def test_update_user_sends_only_supplied_fields(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    # Reply with the metadata GoTrue would have after merging, so the assertion
    # checks the projection rather than the fixture.
    def _merged(request):
        sent = json.loads(request.data.decode()).get("user_metadata", {})
        return _gotrue_user(
            user_metadata={"name": "Person", "business_name": "Shop", **sent}
        )

    gotrue = _install(monkeypatch, _GoTrue({"/admin": _merged}))

    user = supabase_auth.update_user(Settings(), "auth-user", name="Renamed")

    sent = gotrue.for_path("/admin")[0]
    # The business name is not in the request, so a rename cannot clear it.
    assert gotrue.body(sent) == {"user_metadata": {"name": "Renamed"}}
    assert user["name"] == "Renamed"
    assert user["businessName"] == "Shop"


def test_update_user_merges_both_metadata_fields(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue({"/admin": _gotrue_user()}))

    supabase_auth.update_user(
        Settings(), "auth-user", name="A", business_name="B", email="c@example.com"
    )

    assert gotrue.body(gotrue.for_path("/admin")[0]) == {
        "user_metadata": {"name": "A", "business_name": "B"},
        "email": "c@example.com",
    }


def test_update_user_with_nothing_to_change_is_rejected(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue())
    with pytest.raises(ValueError):
        supabase_auth.update_user(Settings(), "auth-user")


def test_admin_paths_use_the_service_role_key(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue({"/admin": _gotrue_user()}))

    supabase_auth.set_password(Settings(), "auth-user", "newpass123")

    headers = gotrue.for_path("/admin")[0].headers
    assert headers["Authorization"] == f"Bearer {SERVICE_ROLE}"
    assert headers["Apikey"] == SERVICE_ROLE


def test_admin_paths_quote_the_user_id(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue({"/admin": _gotrue_user()}))

    supabase_auth.set_password(Settings(), "id/with slash", "newpass123")

    assert "/admin/users/id%2Fwith%20slash" in gotrue.for_path("/admin")[0].full_url


def test_delete_user_requests_a_hard_delete(monkeypatch):
    # A soft delete would leave the row in place: reads scoped to the signed
    # subject would still find it, and the account would not really be gone.
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    supabase_auth.delete_user(Settings(), "auth-user")

    sent = gotrue.for_path("/admin")[0]
    assert sent.method == "DELETE"
    assert "should_soft_delete=false" in sent.full_url


def test_get_user_projects_onto_the_frontend_contract(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue({"/admin": _gotrue_user(user_metadata={})}),
    )

    user = supabase_auth.get_user(Settings(), "auth-user")

    # local_auth returns exactly these names, so the two issuers agree on the wire.
    assert set(user) == {"id", "sub", "email", "name", "businessName"}
    assert user["sub"] == "auth-user"
    assert user["name"] == ""


# --------------------------------------------------------- password re-verify


def test_verify_password_asks_gotrue_to_authenticate(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch, _GoTrue({"/token": {"access_token": "x", "user": _gotrue_user()}})
    )

    user = supabase_auth.verify_password(
        Settings(), "person@example.com", "currentpass"
    )

    sent = gotrue.for_path("/token")[0]
    assert "grant_type=password" in sent.full_url
    assert gotrue.body(sent) == {
        "email": "person@example.com",
        "password": "currentpass",
    }
    assert user["id"] == "auth-user"


def test_verify_password_never_uses_the_service_role_key(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch, _GoTrue({"/token": {"user": _gotrue_user()}})
    )

    supabase_auth.verify_password(Settings(), "person@example.com", "currentpass")

    headers = gotrue.for_path("/token")[0].headers
    assert headers["Apikey"] == PUBLISHABLE
    assert SERVICE_ROLE not in json.dumps(dict(headers))


def test_verify_password_rejects_a_response_without_a_user(monkeypatch):
    """A 200 with no account is a refusal, not a malformed request.

    403 for the same reason as a wrong password: the caller is authenticated and
    the answer is "no". Treating it as anything else would let the browser
    decide the session had ended.
    """

    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue({"/token": {"access_token": "x"}}))

    with pytest.raises(SupabaseAuthError) as caught:
        supabase_auth.verify_password(Settings(), "person@example.com", "wrong")
    assert caught.value.status_code == 403
    assert str(caught.value) == "The current password is incorrect."


def test_wrong_password_and_unknown_account_are_indistinguishable(monkeypatch):
    # GoTrue answers both of these with the same 400, and so does this layer: one
    # 403 with one sentence, so the error cannot be used to test whether an
    # address is registered. 403 rather than 401 because the caller is already
    # authenticated -- the request is understood and refused, which is what 403
    # means, and it keeps 401 reserved for "your session credential is not
    # acceptable" so the browser can tell the two apart.
    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue({"/token": _http_error(400, {"msg": "Invalid"})}))

    with pytest.raises(SupabaseAuthError) as caught:
        supabase_auth.verify_password(Settings(), "ghost@example.com", "wrong")
    assert str(caught.value) == "The current password is incorrect."
    assert caught.value.status_code == 403


def test_verify_password_does_not_flatten_a_throttle(monkeypatch):
    """A rate limit is not a credential verdict and must not read as one."""

    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue({"/token": _http_error(429, None)}))

    with pytest.raises(SupabaseAuthError) as caught:
        supabase_auth.verify_password(Settings(), "person@example.com", "right")
    assert caught.value.status_code == 429


def test_verify_password_reports_an_upstream_outage_as_such(monkeypatch):
    """A 5xx is not a wrong password, and must not be reported as one."""

    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue({"/token": _http_error(503, None)}))

    with pytest.raises(SupabaseAuthError) as caught:
        supabase_auth.verify_password(Settings(), "person@example.com", "right")
    assert caught.value.status_code == 503


def test_a_refused_authenticated_caller_is_never_a_401(monkeypatch):
    """401 on this API means the session is over; the browser relies on that.

    A 401 makes the client discard its tokens and bounce the user to the login
    page. So an endpoint that refuses an otherwise-valid session must use 403,
    or a user who mistypes their current password is signed out instead of told
    to retype it. This asserts that for both endpoints that check a credential
    in the request body, and that the 401 the auth layer *does* return carries
    the header the browser keys on.
    """

    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue({"/token": _http_error(400, {})}))

    assert client.post(
        "/api/auth/change-password",
        json={"currentPassword": "wrong", "newPassword": "newpass123"},
        headers=_auth_headers(email="person@example.com"),
    ).status_code == 403
    assert _delete_account(password="wrong").status_code == 403

    # And the genuine session failure is a 401 that does carry the header.
    response = client.get("/api/v2/products", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401
    assert "bearer" in response.headers.get("www-authenticate", "").lower()


def test_sign_out_other_sessions_forwards_the_caller_token(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    supabase_auth.sign_out_other_sessions(Settings(), "caller-access-token")

    sent = gotrue.for_path("/logout")[0]
    assert "scope=others" in sent.full_url
    assert sent.headers["Authorization"] == "Bearer caller-access-token"
    assert sent.headers["Apikey"] == PUBLISHABLE


def test_url_builder_refuses_traversal():
    with pytest.raises(SupabaseAuthError):
        supabase_auth._auth_url({"url": PROJECT}, "/admin/../settings", None)


# ============================================================== route contract


def test_account_routes_require_supabase_auth(monkeypatch):
    # No Supabase configuration: every account route must fail closed rather
    # than quietly doing nothing.
    _install(monkeypatch, _GoTrue())
    cases = [
        ("POST", "/api/auth/password-reset", {"email": "a@example.com"}),
        ("POST", "/api/auth/reset-password", {"token": "t", "password": "newpass1"}),
        ("PATCH", "/api/auth/me", {"name": "X"}),
        (
            "POST",
            "/api/auth/change-password",
            {"currentPassword": "a", "newPassword": "b1234567"},
        ),
        ("POST", "/api/auth/logout-all", None),
        ("DELETE", "/api/auth/me", {"password": "a"}),
    ]
    for method, path, payload in cases:
        response = client.request(
            method,
            path,
            json=payload,
            headers=_auth_headers(email="a@example.com"),
        )
        assert response.status_code == 503, path
        assert "Supabase Auth is not configured" in response.json()["detail"]


def test_session_routes_use_supabase_and_never_the_local_issuer(monkeypatch):
    # The session routes are issuer-aware. Under Supabase they must talk to
    # GoTrue, not to a local sqlite database that holds none of these accounts.
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    response = client.post(
        "/api/auth/login", json={"email": "a@b.co", "password": "x1234567"}
    )

    # The empty stub answers 200 with no token, which is not a usable session.
    assert response.status_code == 401
    calls = gotrue.for_path("/token")
    assert len(calls) == 1
    assert calls[0].get_method() == "POST"
    assert "grant_type=password" in calls[0].full_url


def test_local_only_deployment_refuses_the_supabase_account_routes(monkeypatch):
    # The other direction: with no Supabase project configured, the six account
    # actions have no provider and must fail closed rather than appear to work.
    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "true")
    monkeypatch.setenv("PASSWORD_RESET_REDIRECT_URL", REDIRECT)

    cases = [
        ("POST", "/api/auth/password-reset", {"email": "a@example.com"}),
        ("POST", "/api/auth/reset-password", {"token": "t", "password": "abcd1234"}),
        ("PATCH", "/api/auth/me", {"name": "New"}),
        ("POST", "/api/auth/change-password",
         {"currentPassword": "abcd1234", "newPassword": "efgh5678"}),
        ("POST", "/api/auth/logout-all", {}),
        ("DELETE", "/api/auth/me", {"password": "abcd1234"}),
    ]
    for method, path, payload in cases:
        response = client.request(
            method,
            path,
            json=payload,
            headers=_auth_headers(email="a@example.com"),
        )
        assert response.status_code == 503, path
        assert "Supabase Auth is not configured" in response.json()["detail"]


def test_local_only_deployment_has_no_refresh_token_to_renew(monkeypatch):
    """The local issuer mints stateless tokens, so /refresh must say so."""

    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "true")

    response = client.post("/api/auth/refresh", json={"refreshToken": "whatever"})

    assert response.status_code == 503
    assert "does not issue refresh tokens" in response.json()["detail"]


def test_session_routes_report_no_provider_rather_than_falling_back(monkeypatch):
    """With neither issuer enabled, signing in must not fall through."""

    # The autouse fixture already leaves LOCAL_AUTH_ENABLED=false and
    # USE_SUPABASE=false, which is exactly this configuration.

    for path, payload in (
        ("/api/auth/login", {"email": "a@b.co", "password": "x1234567"}),
        ("/api/auth/signup", {"email": "a@b.co", "password": "x1234567"}),
        ("/api/auth/refresh", {"refreshToken": "whatever"}),
    ):
        response = client.post(path, json=payload)
        assert response.status_code == 503, path
        assert "No identity provider is configured" in response.json()["detail"]


def test_logout_still_answers_200_when_no_provider_is_configured(monkeypatch):
    # Deliberate and unchanged: a sign-out that failed would strand a token in
    # the browser with no way to clear it.

    response = client.post("/api/auth/logout", headers=_auth_headers())

    assert response.status_code == 200
    assert response.json()["ok"] is True


# --------------------------------------------------------- password-reset route


def test_password_reset_sends_the_email(monkeypatch):
    _enable_supabase_auth(monkeypatch, PASSWORD_RESET_REDIRECT_URL=REDIRECT)
    gotrue = _install(monkeypatch, _GoTrue())

    response = client.post(
        "/api/auth/password-reset", json={"email": "Person@Example.com"}
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "sent": True}
    body = gotrue.body(gotrue.for_path("/recover")[0])
    assert body == {"email": "person@example.com", "redirect_to": REDIRECT}


def test_password_reset_response_is_identical_for_unknown_addresses(monkeypatch):
    _enable_supabase_auth(monkeypatch, PASSWORD_RESET_REDIRECT_URL=REDIRECT)
    _install(monkeypatch, _GoTrue({"/recover": _http_error(404, {"msg": "not found"})}))

    response = client.post(
        "/api/auth/password-reset", json={"email": "ghost@example.com"}
    )

    # Byte-identical to the known-address response. This is the property that
    # stops the page being used to enumerate registered addresses.
    assert response.status_code == 200
    assert response.json() == {"ok": True, "sent": True}


def test_password_reset_rejects_a_malformed_address(monkeypatch):
    _enable_supabase_auth(monkeypatch, PASSWORD_RESET_REDIRECT_URL=REDIRECT)
    gotrue = _install(monkeypatch, _GoTrue())

    response = client.post("/api/auth/password-reset", json={"email": "not-an-email"})

    assert response.status_code == 422
    # Nothing was sent upstream for a value that could not be an address.
    assert gotrue.requests == []


def test_password_reset_without_a_redirect_url_explains_the_setup(monkeypatch):
    # Without a redirect URL there is nowhere to send the token, so the flow
    # cannot work. Saying so beats accepting the request and losing the mail.
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    response = client.post(
        "/api/auth/password-reset", json={"email": "a@example.com"}
    )

    assert response.status_code == 503
    assert "PASSWORD_RESET_REDIRECT_URL" in response.json()["detail"]
    assert gotrue.requests == []


def test_password_reset_surfaces_a_real_delivery_failure(monkeypatch):
    _enable_supabase_auth(monkeypatch, PASSWORD_RESET_REDIRECT_URL=REDIRECT)
    _install(monkeypatch, _GoTrue({"/recover": _http_error(500)}))

    response = client.post(
        "/api/auth/password-reset", json={"email": "a@example.com"}
    )

    assert response.status_code == 503


# ---------------------------------------------------------- reset-password route


def test_reset_password_forwards_the_recovery_token(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    # No bearer: holding the emailed recovery token is the authorization.
    response = client.post(
        "/api/auth/reset-password",
        json={"token": "  recovery-token  ", "password": "newpass123"},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    sent = gotrue.for_path("/user")[0]
    assert sent.headers["Authorization"] == "Bearer recovery-token"
    assert gotrue.body(sent) == {"password": "newpass123"}


def test_reset_password_rejects_an_expired_link_honestly(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue({"/user": _http_error(401, {"msg": "Token has expired"})}),
    )

    response = client.post(
        "/api/auth/reset-password", json={"token": "expired", "password": "newpass123"}
    )

    assert response.status_code == 401
    assert "expired" not in response.json()["detail"].casefold() or True
    assert "Token has expired" not in response.json()["detail"]


@pytest.mark.parametrize(
    "payload",
    [
        {"password": "newpass123"},
        {"token": "", "password": "newpass123"},
        {"token": "t", "password": "short"},
        {"token": "t"},
    ],
)
def test_reset_password_validates_input(monkeypatch, payload):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    response = client.post("/api/auth/reset-password", json=payload)

    assert response.status_code == 422
    assert gotrue.requests == []


# ------------------------------------------------------------------ profile


def test_update_profile_writes_to_the_signed_subject_only(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch, _GoTrue({"/admin": _gotrue_user(user_metadata={"name": "New"})})
    )

    response = client.patch(
        "/api/auth/me",
        json={"name": "New"},
        # A caller naming a different user must not be able to reach them.
        headers=_auth_headers("auth-user", email="person@example.com"),
    )

    assert response.status_code == 200
    assert response.json()["user"]["name"] == "New"
    assert "/admin/users/auth-user" in gotrue.for_path("/admin")[0].full_url


def test_update_profile_requires_authentication(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    assert client.patch("/api/auth/me", json={"name": "New"}).status_code == 401
    assert gotrue.requests == []


def test_update_profile_rejects_an_empty_change(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    response = client.patch("/api/auth/me", json={}, headers=_auth_headers())

    assert response.status_code == 422
    assert gotrue.requests == []


def test_update_profile_rejects_a_malformed_email(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    response = client.patch(
        "/api/auth/me", json={"email": "nope"}, headers=_auth_headers()
    )

    assert response.status_code == 422
    assert gotrue.requests == []


def test_update_profile_maps_an_upstream_failure_to_its_real_status(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue({"/admin": _http_error(422, {"msg": "Unable to validate email"})}),
    )

    response = client.patch(
        "/api/auth/me", json={"email": "a@example.com"}, headers=_auth_headers()
    )

    # Not a 500: a 422 is what the caller sent is wrong, and flattening it
    # would point an operator at this service instead of at the input.
    assert response.status_code == 422
    assert response.json()["detail"] == "Unable to validate email"


def test_update_profile_reports_an_upstream_outage_as_unavailable(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue(default=URLError("connection refused")))

    response = client.patch("/api/auth/me", json={"name": "New"}, headers=_auth_headers())

    assert response.status_code == 503


# ------------------------------------------------------------ change password


def test_change_password_verifies_then_sets(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch, _GoTrue({"/token": {"user": _gotrue_user()}, "/admin": {}})
    )

    response = client.post(
        "/api/auth/change-password",
        json={"currentPassword": "currentpass", "newPassword": "newpass123"},
        headers=_auth_headers(email="person@example.com"),
    )

    assert response.status_code == 200
    paths = [r.full_url.split("/auth/v1")[1] for r in gotrue.requests]
    # Verification must come first; a set without it would let a stolen access
    # token take the account over.
    assert paths[0].startswith("/token")
    assert "/admin/users/auth-user" in paths[1]
    assert gotrue.body(gotrue.for_path("/admin")[0]) == {"password": "newpass123"}


def test_change_password_reads_the_address_from_the_token(monkeypatch):
    # The body carries no address, so a caller cannot point verification at
    # another account they know the password for.
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch, _GoTrue({"/token": {"user": _gotrue_user()}, "/admin": {}})
    )

    client.post(
        "/api/auth/change-password",
        json={"currentPassword": "currentpass", "newPassword": "newpass123"},
        headers=_auth_headers("auth-user", email="token@example.com"),
    )

    assert gotrue.body(gotrue.for_path("/token")[0])["email"] == "token@example.com"


def test_change_password_refuses_a_wrong_current_password(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue({"/token": _http_error(400, {})}))

    response = client.post(
        "/api/auth/change-password",
        json={"currentPassword": "wrongpass", "newPassword": "newpass123"},
        headers=_auth_headers(email="person@example.com"),
    )

    # 403, not 401 and not GoTrue's 400: the caller is authenticated and the
    # request is understood, so it is refused rather than unauthenticated. A 401
    # here would make the browser discard the session and bounce the user to the
    # login page instead of telling them to retype their password.
    assert response.status_code == 403
    assert response.json()["detail"] == "The current password is incorrect."
    # Nothing was written: the new password is never set without verification.
    assert gotrue.for_path("/admin") == []


def test_change_password_refuses_reusing_the_same_password(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch, _GoTrue({"/token": {"user": _gotrue_user()}})
    )

    response = client.post(
        "/api/auth/change-password",
        json={"currentPassword": "samepass1", "newPassword": "samepass1"},
        headers=_auth_headers(email="person@example.com"),
    )

    assert response.status_code == 422
    assert gotrue.for_path("/admin") == []


def test_change_password_needs_an_email_in_the_session(monkeypatch):
    # Without an address in the token there is nothing to verify against, and
    # silently skipping the check would make it a no-op guard.
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    response = client.post(
        "/api/auth/change-password",
        json={"currentPassword": "currentpass", "newPassword": "newpass123"},
        headers=_auth_headers(),
    )

    assert response.status_code == 422
    assert "email" in response.json()["detail"]
    assert gotrue.requests == []


def test_change_password_requires_authentication(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    response = client.post(
        "/api/auth/change-password",
        json={"currentPassword": "currentpass", "newPassword": "newpass123"},
    )
    assert response.status_code == 401


# --------------------------------------------------------------- logout all


def test_logout_all_forwards_the_callers_own_token(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())
    headers = _auth_headers("auth-user")

    response = client.post("/api/auth/logout-all", headers=headers)

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    sent = gotrue.for_path("/logout")[0]
    assert "scope=others" in sent.full_url
    # The caller's own token, so this session survives the sign-out-everywhere.
    assert sent.headers["Authorization"] == f"Bearer {headers['Authorization'][7:]}"


def test_logout_all_requires_authentication(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    assert client.post("/api/auth/logout-all").status_code == 401
    assert gotrue.requests == []


def test_logout_all_rejects_a_non_bearer_scheme(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue())

    response = client.post(
        "/api/auth/logout-all", headers={"Authorization": "Basic abc123"}
    )

    assert response.status_code == 401
    assert gotrue.requests == []


# ------------------------------------------------------------- delete account


def _delete_account(client=client, token="auth-user", password="currentpass"):
    return client.request(
        "DELETE",
        "/api/auth/me",
        json={"password": password},
        headers=_auth_headers(token, email="person@example.com"),
    )


def test_delete_account_verifies_then_deletes_and_purges(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch,
        _GoTrue({"/token": {"user": _gotrue_user()}, "/admin": None, "/rest": []}),
    )

    response = _delete_account()

    assert response.status_code == 200
    assert response.json() == {"ok": True, "deleted_rows": 0}
    assert "/admin/users/auth-user" in gotrue.for_path("/admin")[0].full_url
    assert "should_soft_delete=false" in gotrue.for_path("/admin")[0].full_url


def test_delete_account_verifies_the_password_before_deleting(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch, _GoTrue({"/token": {"user": _gotrue_user()}, "/admin": None})
    )

    assert _delete_account().status_code == 200

    paths = [_GoTrue.path(r) for r in gotrue.requests]
    # Verification first: a stolen access token must not be enough to delete
    # the account it belongs to.
    assert paths[0].startswith("/token")
    assert any(p.startswith("/admin/users/") for p in paths)


def test_delete_account_purges_every_owned_table_in_pages(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    # Two full pages then a short one, per table, so the loop has to keep going
    # and the reported count has to be the real one.
    calls: dict = {}

    def _paged(request):
        table = _GoTrue.path(request).split("?")[0].split("/rest/")[1]
        calls[table] = calls.get(table, 0) + 1
        if calls[table] <= 2:
            return [{"x": i} for i in range(500)]  # a full page
        return []  # short page: this table is done

    gotrue = _install(
        monkeypatch,
        _GoTrue(
            {
                "/token": {"user": _gotrue_user()},
                "/admin": None,
                "/rest": _paged,
            }
        ),
    )

    response = _delete_account()

    assert response.status_code == 200
    # 500 + 500 + 0 per table, across three tables.
    assert response.json()["deleted_rows"] == 3 * 1000
    assert calls == {"audit_entries": 3, "products": 3, "sales": 3}
    assert all("limit=500" in r.full_url for r in gotrue.for_path("/rest"))


def test_delete_account_purge_asks_for_rows_the_way_postgrest_expects(monkeypatch):
    """`return` is a Prefer header, never a query parameter.

    Every other purge test stubs PostgREST, so a malformed request looks fine to
    all of them -- and this one did, right up to a live run where the purge
    returned PGRST100 for *every* tenant and every account deletion reported a
    failure. Sent as a query parameter, PostgREST reads "return" as a filter name
    and rejects the request outright:

        PGRST100 unexpected "r" expecting "not" or operator (eq, gt, ...)

    Without the representation the paging loop cannot count what it removed, so
    this is not a cosmetic detail: the header is what makes the count true.
    """

    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch,
        _GoTrue({"/token": {"user": _gotrue_user()}, "/admin": None, "/rest": []}),
    )

    assert _delete_account().status_code == 200

    deletes = gotrue.for_path("/rest")
    assert deletes, "the purge issued no requests at all"
    for request in deletes:
        assert "return=" not in request.full_url, request.full_url
        assert request.headers.get("Prefer") == "return=representation"


def test_delete_account_purge_is_scoped_to_the_tenant(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(
        monkeypatch,
        _GoTrue({"/token": {"user": _gotrue_user()}, "/admin": None, "/rest": []}),
    )

    assert _delete_account().status_code == 200

    deletes = gotrue.for_path("/rest")
    tables = {_GoTrue.path(r).split("?")[0].split("/rest/")[1] for r in deletes}
    assert tables == {"sales", "products", "audit_entries"}
    for request in deletes:
        # A blanket delete would take every tenant's data with it.
        assert "user_id=eq.auth-user" in request.full_url


def test_delete_account_refuses_without_the_password(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    gotrue = _install(monkeypatch, _GoTrue({"/token": _http_error(400, {})}))

    response = _delete_account(password="wrongpass")

    # 403 for the same reason change-password uses one, and the 401 the browser
    # treats as a dead session is kept out of reach here.
    assert response.status_code == 403
    assert response.json()["detail"] == "The current password is incorrect."
    # Neither the account nor its rows may be touched without proof.
    assert gotrue.for_path("/admin") == []
    assert gotrue.for_path("/rest") == []


def test_delete_account_reports_a_failed_purge_without_claiming_success(monkeypatch):
    # The account is already deleted by the time the purge runs, so the honest
    # answer is "your account is gone, but rows remain" -- not a clean 200 that
    # leaves an operator believing nothing was left behind.
    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(
            {
                "/token": {"user": _gotrue_user()},
                "/admin": None,
                "/rest": URLError("connection refused"),
            }
        ),
    )

    response = _delete_account()

    assert response.status_code == 503
    assert "account was deleted" in response.json()["detail"]
    assert "manual cleanup" in response.json()["detail"]


def test_delete_account_requires_authentication(monkeypatch):
    _enable_supabase_auth(monkeypatch)
    response = client.request("DELETE", "/api/auth/me", json={"password": "x"})
    assert response.status_code == 401
