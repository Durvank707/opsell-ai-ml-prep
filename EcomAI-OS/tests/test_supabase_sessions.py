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
import re
import secrets
import time
from pathlib import Path

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
    """A project that *does* say the address is taken gets an actionable message.

    Not every GoTrue configuration is as discreet as this one: the local issuer
    answers 409 and some projects answer 422. Where the address is disclosed, the
    wording now says what to do about it, because "User already registered" is
    precisely what somebody sees when they retry after a confirmation mail never
    arrived, and it left them with no way forward.

    This project's own GoTrue does not take this path -- it returns 200 with a
    synthetic user instead, which
    ``test_a_signup_on_an_existing_account_is_still_answered_as_accepted`` covers.
    This test is here for the configurations that do.
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
    detail = response.json()["detail"]
    # Same 422 and the same disclosure as before, but now it says what to do.
    # "User already registered" is precisely what somebody sees when they retry
    # after their first confirmation mail never arrived, and it offered no way on.
    assert detail != "User already registered"
    assert "already exists" in detail
    assert "Sign in" in detail
    assert "reset your password" in detail


# ------------------------------------------------- signup: created, not signed in


def test_a_signup_that_omits_the_user_still_asks_the_user_to_verify(monkeypatch):
    """The reported failure: a signup that succeeded, reported as a 502.

    With "Confirm email" on, GoTrue makes the ``user`` field optional and omits
    it from the reply. The account was created and the mail was on its way, but
    the old check read the missing user as "nothing happened" and answered
    "Supabase Auth did not return an account for that signup" -- telling somebody
    to try again for an account that already existed, which on a retry would then
    come back as a duplicate.

    A 2xx is the acknowledgement; the absence of a user is not a failure.
    """

    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(
            routes={
                "/signup": {
                    "confirmation_sent_at": "2026-01-01T00:00:00Z",
                    "access_token": "",
                    "refresh_token": "",
                    "token_type": "",
                    "expires_in": 0,
                }
            }
        ),
    )

    response = client.post(
        "/api/auth/signup",
        json={"email": "person@example.com", "password": "correct horse"},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["confirmation_required"] is True
    assert body["access_token"] == ""
    assert body["refresh_token"] == ""
    # The address is the caller's own, so the envelope stays self-consistent, but
    # no id is invented: one was never issued and no token will carry it.
    assert body["user"]["email"] == "person@example.com"
    assert body["user"]["id"] == ""


def test_a_signup_with_no_body_at_all_still_asks_the_user_to_verify(monkeypatch):
    """A 2xx with an empty body is still an accepted signup.

    ``_auth_request`` returns ``None`` for a body-less 2xx, which is a shape
    GoTrue is free to send. Rejecting it here would reproduce the original bug for
    a second reason, so the acknowledgement is taken from the status alone.
    """

    _enable_supabase_auth(monkeypatch)
    _install(monkeypatch, _GoTrue(routes={"/signup": {}}))

    response = client.post(
        "/api/auth/signup",
        json={"email": "person@example.com", "password": "correct horse"},
    )

    assert response.status_code == 201, response.text
    assert response.json()["confirmation_required"] is True


def test_a_signup_on_an_existing_account_is_still_answered_as_accepted(monkeypatch):
    """GoTrue will not say whether the address was already registered.

    Signing up with an address that already has a confirmed account answers 200
    with a synthetic user -- a fresh-looking id and ``confirmation_sent_at``, for a
    record that does not exist and an email that was never sent. That was
    observed against the live project: the reply carried an id absent from the
    user table, and the table did not grow.

    So the response must be shaped exactly like any other accepted signup, and in
    particular must not claim an account exists. A test that only covered the
    "user already registered" 422 would have missed this entirely, which is the
    shape GoTrue actually sends here.
    """

    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(
            routes={
                # The decoy, exactly as the live project sent it: a bare user
                # object at the top level, for a record that does not exist.
                "/signup": {
                    "id": "decoy-0000-4000-8000-000000000000",
                    "aud": "authenticated",
                    "role": "",
                    "email": "person@example.com",
                    "confirmation_sent_at": "2026-09-28T06:50:27.620746688Z",
                    "created_at": "2026-09-28T06:50:27.620746688Z",
                    "app_metadata": {"provider": "email", "providers": ["email"]},
                    "user_metadata": {},
                    "identities": [],
                }
            }
        ),
    )

    response = client.post(
        "/api/auth/signup",
        json={"email": "person@example.com", "password": "correct horse"},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    # Shaped like any accepted signup: no session, and confirmation still required.
    assert body["confirmation_required"] is True
    assert body["access_token"] == ""
    assert body["refresh_token"] == ""
    # The address is the caller's own, so the panel can name it.
    assert body["user"]["email"] == "person@example.com"
    # The decoy's id is never surfaced. It identifies no account, and a client
    # that treated it as a subject would be holding a reference to nothing.
    assert body["user"]["id"] == ""


def test_a_pending_verification_never_hands_over_a_credential(monkeypatch):
    """No token of any kind may appear while verification is outstanding.

    This is the property that stops signup becoming a way around email
    verification: a client that stored anything from this response would be
    holding a usable session for an unverified account. Checked over the whole
    serialized body, not just the two known fields, so a new one cannot slip in.
    """

    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(
            routes={
                "/signup": {
                    "access_token": "",
                    "refresh_token": "",
                    "user": {
                        "id": "sup-user-1",
                        "email": "person@example.com",
                    },
                }
            }
        ),
    )

    response = client.post(
        "/api/auth/signup",
        json={"email": "person@example.com", "password": "correct horse"},
    )

    assert response.status_code == 201
    serialized = json.dumps(response.json())
    assert "access_token" in serialized  # the key is present...
    assert response.json()["access_token"] == ""  # ...and empty
    # Nothing that could be replayed as a bearer.
    assert "eyJ" not in serialized


def test_a_signup_that_failed_is_never_reported_as_created(monkeypatch):
    """The other side of the rule: a non-2xx still fails.

    Reading the acknowledgement too generously would be worse than the original
    bug -- it would tell people to check an inbox for mail that was never sent.
    Every rejection has to keep propagating.
    """

    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(default=_http_error(422, {"msg": "Password should be at least 6 characters"})),
    )

    response = client.post(
        "/api/auth/signup",
        json={"email": "person@example.com", "password": "x"},
    )

    assert response.status_code == 422
    assert "confirmation_required" not in response.json()


def test_a_mailer_failure_says_what_to_do_instead_of_a_500(monkeypatch):
    """A confirmation mail that will not send is the common real-world failure.

    A project without custom SMTP cannot deliver to most addresses, and GoTrue
    answers 500. The upstream wording ("Error sending confirmation email") is not
    actionable and the status implies a server fault rather than a retry, so both
    are recast for the person signing up.
    """

    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(
            default=_http_error(
                500,
                {
                    "code": 500,
                    "error_code": "unexpected_failure",
                    "msg": "Error sending confirmation email",
                },
            )
        ),
    )

    response = client.post(
        "/api/auth/signup",
        json={"email": "person@example.com", "password": "correct horse"},
    )

    assert response.status_code == 503, response.text
    detail = response.json()["detail"]
    assert "Error sending confirmation email" not in detail
    assert "confirmation email" in detail
    assert "not created" in detail, "the user must know they hold no account"
    assert "try again" in detail, "and be given the next step"
    # It must not also claim a session exists.
    assert "access_token" not in response.json()


def test_an_unexpected_signup_failure_is_left_alone(monkeypatch):
    """Only the two signup-specific messages are recast.

    Anything else keeps its own status and wording, so a rate limit stays a rate
    limit and a real outage is not disguised as a retryable mail problem.
    """

    _enable_supabase_auth(monkeypatch)
    _install(
        monkeypatch,
        _GoTrue(default=_http_error(429, {"msg": "Email rate limit exceeded"})),
    )

    response = client.post(
        "/api/auth/signup",
        json={"email": "person@example.com", "password": "correct horse"},
    )

    assert response.status_code == 429
    assert response.json()["detail"] == "Email rate limit exceeded"


def test_a_verified_user_signs_in_normally_after_confirming(monkeypatch):
    """The whole flow, end to end: sign up, verify, then sign in for real.

    Signup deliberately returns no session, so the only way in is the ordinary
    password grant once the user has confirmed. The stub models the state GoTrue
    holds -- the account exists but is unconfirmed, and only becomes usable after
    the emailed link is followed -- so this asserts the two ends of the flow meet
    correctly: nothing is issued early, and afterwards the normal login works.
    """

    _enable_supabase_auth(monkeypatch)
    state = {"confirmed": False}

    def route(request):
        if request.get_method() == "POST" and request.full_url.endswith("/signup"):
            # The account is created; no session is issued.
            return {"confirmation_sent_at": "2026-01-01T00:00:00Z"}
        if not state["confirmed"]:
            # What GoTrue answers while the account is still unconfirmed. Our
            # login flattens every credential failure to one message, so the
            # wording here must not leak through either.
            raise _http_error(400, {"msg": "Email not confirmed"})
        return _session(user_id="sup-user-new", email="person@example.com")

    _install(monkeypatch, _GoTrue(default=route))

    signup = client.post(
        "/api/auth/signup",
        json={"email": "person@example.com", "password": "correct horse"},
    )
    assert signup.status_code == 201, signup.text
    assert signup.json()["confirmation_required"] is True
    assert signup.json()["access_token"] == ""
    assert signup.json()["refresh_token"] == ""

    # The user follows the emailed link. Up to that point there is no way in.
    refused = client.post(
        "/api/auth/login",
        json={"email": "person@example.com", "password": "correct horse"},
    )
    assert refused.status_code == 401
    assert "not confirmed" not in refused.json()["detail"].lower()

    state["confirmed"] = True
    login = client.post(
        "/api/auth/login",
        json={"email": "person@example.com", "password": "correct horse"},
    )
    assert login.status_code == 200, login.text
    body = login.json()
    assert body["access_token"] == ACCESS
    assert body["user"]["id"] == "sup-user-new"


# --------------------------------------------------- the client half of the flow
#
# The backend change above is only half the fix: the browser has to act on
# ``confirmation_required`` by *not* signing anyone in, and it has to be able to
# get them to the login page afterwards. There is no JavaScript test runner in
# the project, so these read the source. What they check is the control flow
# rather than the copy -- the failure mode is a well-worded page that quietly
# stored a session, which reading the rendered text would never reveal.

_SRC = Path(__file__).resolve().parents[1] / "frontend" / "src"
SIGNUP_JSX = _SRC / "pages" / "auth" / "SignupPage.jsx"
AUTH_SERVICE_JS = _SRC / "services" / "authService.js"
AUTH_CONTEXT_JSX = _SRC / "context" / "AuthContext.jsx"


def _read(path: Path) -> str:
    assert path.exists(), f"frontend source not found at {path}"
    return path.read_text(encoding="utf-8")


def test_a_pending_verification_stores_no_session_in_the_browser():
    # The dangerous line is the one that would make signup a way around email
    # verification: writing the response into the token store. It has to be
    # unreachable while confirmation is outstanding, which means the early
    # return has to come first.
    source = _read(AUTH_SERVICE_JS)
    found = re.search(r"export async function signup\((.*?)\n\}", source, re.DOTALL)
    assert found, "signup is not exported from the auth service"
    service = found.group(1)

    branch = service.index("confirmation_required")
    store = service.index("storeSession(result)")
    assert branch < store, "the confirmation branch must return before storing a session"
    between = service[branch:store]
    assert "confirmationRequired: true" in between
    assert "token: ''" in between, "an empty token, not a stored one"
    assert "storeSession" not in between


def test_the_signup_page_does_not_navigate_into_the_app_while_unverified():
    source = _read(SIGNUP_JSX)
    found = re.search(r"const handleSubmit = async \(e\) => \{(.*?)\n  \};", source, re.DOTALL)
    assert found, "handleSubmit is not defined on the signup page"
    body = found.group(1)

    assert "if (confirmationRequired) {" in body
    branch = body[body.index("if (confirmationRequired) {") : body.index("toast.success")]
    assert "navigate(" not in branch, "the unverified branch must not navigate anywhere"
    assert "return" in branch, "and it has to stop there"
    # Signing in afterwards is the only way on, and it is an ordinary link.
    assert 'to="/login"' in source


def test_the_unverified_user_is_never_adopted_as_a_signed_in_user():
    # Setting the user would render an authenticated shell whose every request
    # then 401s, which is the confusing half-failure this flow exists to avoid.
    source = _read(AUTH_CONTEXT_JSX)
    found = re.search(
        r"const signup = useCallback\(async \(payload\) => \{(.*?)\n  \}, \[\]\);",
        source,
        re.DOTALL,
    )
    assert found, "signup is not wired through the auth context"
    assert "if (!confirmationRequired) setUser(u);" in found.group(1)


def test_the_confirmation_screen_does_not_promise_an_account_it_cannot_know_about():
    """The wording has to be true for every signup GoTrue accepts.

    GoTrue answers 200 both for a new address and for one that already has a
    confirmed account, on purpose, so that this endpoint cannot be used to test
    whether somebody is registered. "Your account is created" is therefore false
    for the second case, where no account was made and no email was sent -- and
    the user would sit waiting for mail that never arrives. The copy has to
    survive both, and it always has to offer signing in as the way through.
    """

    source = _read(SIGNUP_JSX)
    panel = re.search(r"\{awaitingConfirmation \? \((.*?)\n        \) : \(", source, re.DOTALL)
    assert panel, "the confirmation screen is not rendered from the signup page"
    body = panel.group(1)

    assert "awaitingConfirmation" in body, "the message should name the address"
    assert 'to="/login"' in body, "signing in must be offered, not just mentioned"
    for overclaim in ("Your account is created", "account has been created", "We sent"):
        assert overclaim not in body, f"the confirmation screen must not say {overclaim!r}"


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
