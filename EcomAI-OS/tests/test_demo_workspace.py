"""The public demo workspace: one dedicated tenant, opened without credentials.

The button this replaces only pre-filled the login form with a credential that
existed in the browser's own local store, so against a real identity provider it
answered "Email or password is incorrect" -- there was no such account to sign in
to. A visitor with no account therefore could not see the product at all.

These tests pin the properties that make the replacement safe, because the whole
point of a credential-free entry point is that it is *not* a way around auth:

* the route has no parameter that could aim it at another account;
* the demo account's password is generated in the server's memory and never
  leaves it, so the account cannot be signed into from outside;
* the session it returns is an ordinary signed token for the demo tenant's own
  subject, so every existing tenant check still applies to it unchanged;
* the demo tenant is flagged in GoTrue metadata, which is what keeps it
  identifiable rather than anonymous.

No test here reaches the network. The ``_urlopen`` seam is the same one the
neighbouring Supabase suites use, and the workspace registry is stubbed so the
tests never touch a tenant store.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import demo_workspace, supabase_auth
from backend.config import Settings
from backend.main import app
from backend.routers.auth import _is_demo_account
from backend.tenant import DEMO_EMAIL
from tests.test_supabase_auth import (
    PUBLISHABLE,
    SECRET,
    SERVICE_ROLE,
    _enable_supabase_auth,
    _GoTrue,
    _http_error,
    _install,
    _token,
)

client = TestClient(app)

DEMO_USER_ID = "3f0b8c1a-0000-4000-8000-0000000000de"
ACCESS = "demo-access-token"
REFRESH = "demo-refresh-token"


@pytest.fixture(autouse=True)
def jwt_environment(monkeypatch):
    """No Supabase and no local issuer unless a test asks for one.

    Same reasoning as the neighbouring suites: without this, every route test
    would fail on the 503 from ``_session_or_503`` rather than on the behaviour
    it is checking.
    """

    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    # The shared ``_token`` helper signs with ``SECRET``, so the verification key
    # has to be that same value or every authenticated route 401s for a reason
    # that has nothing to do with what is being tested.
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
    # The demo identity is cached in module state for the life of the process, so
    # each test has to start from scratch or one test's password would satisfy
    # another's assertions.
    demo_workspace.reset_cached_identity()


@pytest.fixture
def supabase_auth_env(monkeypatch):
    return _enable_supabase_auth(monkeypatch)


class _Workspace:
    """A stand-in tenant workspace that records what it was seeded with."""

    def __init__(self, user_id: str, products: int = 0, sales: int = 0):
        self.user_id = user_id
        self.email = DEMO_EMAIL
        self.products = {} if not products else {f"P{i}": {} for i in range(products)}
        self.sales_records = [] if not sales else [{} for _ in range(sales)]

    def __len__(self):
        return len(self.products)


@pytest.fixture
def stub_workspace(monkeypatch):
    """Replace the workspace registry so no test opens a real tenant store."""

    created: list[str] = []
    seeded: list[str] = []

    def install(products: int = 5, sales: int = 1000):
        def get_workspace(user_id, email=None):
            created.append(user_id)
            return _Workspace(user_id, products, sales)

        def seed(ws, limit=None):
            seeded.append(ws.user_id)
            ws.products = {f"P{i}": {} for i in range(5)}
            ws.sales_records = [{} for _ in range(1000)]
            return 1000

        monkeypatch.setattr("backend.routers.v2.get_workspace", get_workspace)
        monkeypatch.setattr("backend.tenant.seed_canonical_demo", seed)
        return created, seeded

    return install


def _session_response(overrides=None):
    payload = {
        "access_token": ACCESS,
        "refresh_token": REFRESH,
        "token_type": "bearer",
        "expires_in": 3600,
        "user": {
            "id": DEMO_USER_ID,
            "sub": DEMO_USER_ID,
            "email": DEMO_EMAIL,
            "name": demo_workspace.DEMO_DISPLAY_NAME,
            "businessName": demo_workspace.DEMO_BUSINESS_NAME,
        },
    }
    if overrides:
        payload.update(overrides)
    return payload


def _absent_but_signable(gotrue: _GoTrue) -> _GoTrue:
    """A GoTrue script where the demo user does not exist yet but can be made.

    ``/admin/users`` answers both verbs, so the fake branches on the method: a
    GET is the lookup that finds nothing, a POST is the provisioning call. A
    single canned reply would satisfy the lookup and then be handed to
    ``create_confirmed_user``, which is why the two have to be told apart.
    """

    def admin_users(request):
        if request.get_method() == "POST":
            return {
                "id": DEMO_USER_ID,
                "email": DEMO_EMAIL,
                "user_metadata": {demo_workspace.DEMO_FLAG: True},
            }
        return {"users": []}

    gotrue.routes = {"/admin/users": admin_users, "/token": _session_response()}
    return gotrue


def _existing_but_signable() -> _GoTrue:
    """A GoTrue script where the demo tenant already exists."""

    return _GoTrue(
        routes={
            "/admin/users": {"users": [{"id": DEMO_USER_ID, "email": DEMO_EMAIL}]},
            "/token": _session_response(),
        }
    )


# ------------------------------------------------------- the GoTrue admin lookups


def test_find_user_by_email_pages_the_admin_list(monkeypatch, supabase_auth_env):
    # GoTrue has no email filter, so the lookup has to page and compare. A short
    # page ends the scan -- that is how a paginated API says "that was the last
    # one" -- so the first page is deliberately full.
    gotrue = _GoTrue()
    full = [{"id": str(i), "email": f"u{i}@else.com"} for i in range(200)]
    pages = {
        "page=1": {"users": full},
        "page=2": {"users": [{"id": DEMO_USER_ID, "email": DEMO_EMAIL}]},
    }
    gotrue.routes = {
        "/admin/users": lambda request: next(
            reply for needle, reply in pages.items() if needle in request.full_url
        )
    }
    _install(monkeypatch, gotrue)

    assert supabase_auth.find_user_id_by_email(supabase_auth_env, DEMO_EMAIL) == DEMO_USER_ID
    assert len(gotrue.for_path("/admin/users")) == 2


def test_find_user_by_email_stops_on_a_short_page(monkeypatch, supabase_auth_env):
    # One page that is not full is the end of the list, so a second request would
    # be a wasted round trip on every demo click.
    gotrue = _GoTrue(
        routes={"/admin/users": {"users": [{"id": "a", "email": "someone@else.com"}]}}
    )
    _install(monkeypatch, gotrue)
    assert supabase_auth.find_user_id_by_email(supabase_auth_env, DEMO_EMAIL) is None
    assert len(gotrue.for_path("/admin/users")) == 1


def test_find_user_by_email_ignores_address_case(monkeypatch, supabase_auth_env):
    # GoTrue treats addresses case-insensitively, so a case-sensitive scan could
    # decide a live account is missing and then fail to create it.
    gotrue = _GoTrue(
        routes={
            "/admin/users": {"users": [{"id": DEMO_USER_ID, "email": "Demo@EcomAI.App"}]}
        }
    )
    _install(monkeypatch, gotrue)
    assert supabase_auth.find_user_id_by_email(supabase_auth_env, DEMO_EMAIL) == DEMO_USER_ID


def test_find_user_by_email_returns_none_when_absent(monkeypatch, supabase_auth_env):
    gotrue = _GoTrue(
        routes={"/admin/users": {"users": [{"id": "a", "email": "someone@else.com"}]}}
    )
    _install(monkeypatch, gotrue)
    assert supabase_auth.find_user_id_by_email(supabase_auth_env, DEMO_EMAIL) is None


def test_find_user_by_email_uses_the_service_role_key(monkeypatch, supabase_auth_env):
    # Scanning the whole user table is an admin read. Doing it with the
    # publishable key would be refused, and doing it as a user-level call would
    # be a privilege the caller has no business having.
    gotrue = _GoTrue(routes={"/admin/users": {"users": []}})
    _install(monkeypatch, gotrue)
    supabase_auth.find_user_id_by_email(supabase_auth_env, DEMO_EMAIL)
    sent = gotrue.for_path("/admin/users")[0]
    assert sent.get_header("Apikey") == SERVICE_ROLE
    assert sent.get_header("Authorization") == f"Bearer {SERVICE_ROLE}"


def test_find_user_by_email_stops_at_the_page_ceiling(monkeypatch, supabase_auth_env):
    # A project with a huge user table must not turn one lookup into a crawl.
    full_page = {"users": [{"id": str(i), "email": f"u{i}@else.com"} for i in range(200)]}
    gotrue = _GoTrue(routes={"/admin/users": full_page})
    _install(monkeypatch, gotrue)
    assert supabase_auth.find_user_id_by_email(supabase_auth_env, DEMO_EMAIL) is None
    assert len(gotrue.for_path("/admin/users")) == supabase_auth._ADMIN_USER_SCAN_PAGES


def test_create_confirmed_user_marks_email_and_flags_the_demo(monkeypatch, supabase_auth_env):
    # An unconfirmed account cannot sign in, which would make provisioning the
    # demo pointless; the flag is what makes it identifiable rather than
    # anonymous in the Supabase dashboard.
    gotrue = _GoTrue(
        routes={
            "/admin/users": {
                "id": DEMO_USER_ID,
                "email": DEMO_EMAIL,
                "user_metadata": {"is_demo": True},
            }
        }
    )
    _install(monkeypatch, gotrue)

    created = supabase_auth.create_confirmed_user(
        supabase_auth_env,
        DEMO_EMAIL,
        "a-password",
        {"name": "Demo Workspace", "business_name": "TerraMart Retail", "is_demo": True},
    )
    assert created["id"] == DEMO_USER_ID
    body = _GoTrue.body(gotrue.for_path("/admin/users")[0])
    assert body["email"] == DEMO_EMAIL
    assert body["email_confirm"] is True
    assert body["user_metadata"]["is_demo"] is True


# --------------------------------------------------------- provisioning the demo


def test_demo_session_provisions_the_tenant_and_signs_in(
    monkeypatch, supabase_auth_env, stub_workspace
):
    # A brand-new tenant has an empty workspace, which is the case that has to
    # reach the canonical seed.
    created, seeded = stub_workspace(products=0, sales=0)
    gotrue = _absent_but_signable(_GoTrue())
    _install(monkeypatch, gotrue)

    session = demo_workspace.demo_session(supabase_auth_env)

    assert session["is_demo"] is True
    assert session["access_token"] == ACCESS
    assert session["seeded"] == {"products": 5, "sales_rows": 1000}
    # A brand-new account: looked up, created through the admin API, then signed
    # in to with a password grant. Creating it is not enough on its own -- the
    # visitor gets a session, not just an account.
    admin_calls = gotrue.for_path("/admin/users")
    assert [r.get_method() for r in admin_calls] == ["GET", "POST"]
    body = _GoTrue.body(admin_calls[1])
    assert body["email"] == DEMO_EMAIL
    assert body["email_confirm"] is True
    assert body["user_metadata"][demo_workspace.DEMO_FLAG] is True
    sign_ins = gotrue.for_path("/token")
    assert [r.get_method() for r in sign_ins] == ["POST"]
    assert _GoTrue.body(sign_ins[0])["email"] == DEMO_EMAIL
    assert created == [DEMO_USER_ID]
    assert seeded == [DEMO_USER_ID]


def test_demo_session_rekeys_an_existing_account(
    monkeypatch, supabase_auth_env, stub_workspace
):
    # The point of holding the password in memory is that no stale copy is ever
    # trusted: an account left over from a previous process is re-keyed, so it
    # has no credential left over from then.
    stub_workspace()
    gotrue = _existing_but_signable()
    _install(monkeypatch, gotrue)

    demo_workspace.demo_session(supabase_auth_env)

    admin_calls = gotrue.for_path("/admin/users")
    assert [r.get_method() for r in admin_calls] == ["GET", "PUT"], (
        "an existing demo account must be looked up and re-keyed, not created"
    )
    rekeyed = _GoTrue.body(admin_calls[1])
    assert len(rekeyed["password"]) >= 32, "the re-key must not be a guessable password"


def test_the_demo_password_never_leaves_the_server(
    monkeypatch, supabase_auth_env, stub_workspace
):
    stub_workspace()
    gotrue = _existing_but_signable()
    _install(monkeypatch, gotrue)

    session = demo_workspace.demo_session(supabase_auth_env)
    identity = demo_workspace._identity
    assert identity is not None and identity.password

    # Nothing in the returned session may carry the credential the server used.
    # This is the assertion that keeps the endpoint from degenerating into a
    # documented way to learn the demo password.
    blob = json.dumps(session, default=str)
    assert identity.password not in blob
    assert "password" not in json.dumps(session.get("user", {}), default=str)
    for key in session:
        assert "password" not in key


def test_the_identity_is_cached_so_repeat_visits_do_not_reprovision(
    monkeypatch, supabase_auth_env, stub_workspace
):
    stub_workspace()
    gotrue = _existing_but_signable()
    _install(monkeypatch, gotrue)

    first = demo_workspace.demo_session(supabase_auth_env)
    second = demo_workspace.demo_session(supabase_auth_env)

    assert first["access_token"] == second["access_token"]
    methods = [r.get_method() for r in gotrue.for_path("/admin/users")]
    assert methods == ["GET", "PUT"], "the second visit must not re-key the account"


def test_seeding_runs_once_and_never_duplicates(
    monkeypatch, supabase_auth_env, stub_workspace
):
    # The workspace is shared by every visitor, so a re-seed on every request
    # would rewrite rows under whoever happened to open the page last.
    created, seeded = stub_workspace(products=5, sales=1000)
    gotrue = _existing_but_signable()
    _install(monkeypatch, gotrue)

    demo_workspace.demo_session(supabase_auth_env)
    demo_workspace.demo_session(supabase_auth_env)

    assert seeded == [], "an already-populated workspace must not be seeded again"


def test_an_emptied_demo_workspace_is_seeded_again(
    monkeypatch, supabase_auth_env, stub_workspace
):
    # A visitor who deletes the sample products should not leave the demo broken
    # for everyone who arrives next.
    created, seeded = stub_workspace(products=0, sales=0)
    gotrue = _existing_but_signable()
    _install(monkeypatch, gotrue)

    session = demo_workspace.demo_session(supabase_auth_env)

    assert seeded == [DEMO_USER_ID]
    assert session["seeded"] == {"products": 5, "sales_rows": 1000}


def test_a_goTrue_failure_is_reported_not_swallowed(monkeypatch, supabase_auth_env, stub_workspace):
    # A 500 is an outage, not a wrong password. Retrying it would double the work
    # against a broken project and then report the same failure anyway, so the
    # upstream error has to come through untouched.
    stub_workspace()
    gotrue = _GoTrue(
        routes={"/admin/users": _http_error(500, {"msg": "boom"}), "/token": _session_response()}
    )
    _install(monkeypatch, gotrue)

    with pytest.raises(supabase_auth.SupabaseAuthError):
        demo_workspace.demo_session(supabase_auth_env)


def test_a_changed_demo_password_is_repaired(monkeypatch, supabase_auth_env, stub_workspace):
    # Settings offers a working "change password" form, so a visitor can change
    # the demo account's own password. That invalidates the credential held in
    # memory, and the demo has to keep working rather than failing until someone
    # restarts the server.
    stub_workspace(products=5, sales=1000)
    attempts = {"n": 0}
    keyed: list[str] = []

    def token(request):
        attempts["n"] += 1
        if attempts["n"] == 1:
            # The fake's callables must *raise*; returning the error would be
            # handed to the JSON encoder as if it were a response body.
            raise _http_error(400, {"error_code": "invalid_credentials"})
        return _session_response()

    def admin_users(request):
        if request.get_method() == "PUT":
            keyed.append(_GoTrue.body(request)["password"])
            return {}
        return {"users": [{"id": DEMO_USER_ID, "email": DEMO_EMAIL}]}

    _install(monkeypatch, _GoTrue(routes={"/admin/users": admin_users, "/token": token}))

    session = demo_workspace.demo_session(supabase_auth_env)

    assert session["is_demo"] is True
    assert attempts["n"] == 2, "the first refusal must be retried exactly once"
    # Each attempt resolves the identity afresh, so each re-keys the account. The
    # passwords have to differ, which is what proves the retry did not simply
    # repeat the value GoTrue had just refused.
    assert len(keyed) == 2, "the retry has to re-key the account, not just try again"
    assert keyed[0] != keyed[1]


def test_the_repair_is_bounded_to_one_attempt(monkeypatch, supabase_auth_env, stub_workspace):
    # If re-keying also fails there is nothing more to try, and looping would hang
    # the request that a visitor is waiting on.
    stub_workspace(products=5, sales=1000)
    attempts = {"n": 0}

    def token(request):
        attempts["n"] += 1
        raise _http_error(400, {"error_code": "invalid_credentials"})

    _install(
        monkeypatch,
        _GoTrue(
            routes={
                "/admin/users": {"users": [{"id": DEMO_USER_ID, "email": DEMO_EMAIL}]},
                "/token": token,
            }
        ),
    )

    with pytest.raises(supabase_auth.SupabaseAuthError):
        demo_workspace.demo_session(supabase_auth_env)

    assert attempts["n"] == 2, "the retry must not repeat"


def test_a_rejected_credential_is_distinguishable_from_an_outage():
    # sign_in flattens every credential failure to one 401, so the message is the
    # only thing that tells a wrong password apart from a broken project. A
    # caller that "repairs" its way out of a refusal must not do that during an
    # outage.
    refused = supabase_auth.SupabaseAuthError("Email or password is incorrect.", status_code=401)
    outage = supabase_auth.SupabaseAuthError("upstream is unavailable", status_code=503)
    assert supabase_auth.credentials_rejected(refused) is True
    assert supabase_auth.credentials_rejected(outage) is False
    assert supabase_auth.credentials_rejected(
        supabase_auth.SupabaseAuthError("Email or password is incorrect.", status_code=500)
    ) is False


# ------------------------------------------------------------------- the route


def test_demo_route_needs_no_credential_or_parameter(monkeypatch, supabase_auth_env, stub_workspace):
    stub_workspace()
    gotrue = _GoTrue()
    _absent_but_signable(gotrue)
    _install(monkeypatch, gotrue)

    response = client.post("/api/auth/demo")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["access_token"] == ACCESS
    assert body["user"]["email"] == DEMO_EMAIL
    assert body["is_demo"] is True


def test_demo_route_cannot_be_aimed_at_another_account(monkeypatch, supabase_auth_env, stub_workspace):
    # A body is not part of the contract, so a caller who supplies one must not be
    # able to change whose session comes back. This is the property that keeps
    # the route from being a general "mint any session" endpoint.
    stub_workspace()
    gotrue = _GoTrue()
    _absent_but_signable(gotrue)
    _install(monkeypatch, gotrue)

    response = client.post(
        "/api/auth/demo",
        json={
            "user_id": "00000000-0000-0000-0000-000000000000",
            "email": "victim@example.com",
            "password": "hunter2",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["user"]["email"] == DEMO_EMAIL
    for request in gotrue.requests:
        assert b"victim@example.com" not in (request.data or b"")
        assert b"hunter2" not in (request.data or b"")


def test_demo_route_needs_no_bearer_token(monkeypatch, supabase_auth_env, stub_workspace):
    # The whole point: a visitor with no account and no session gets in. A
    # required credential here would be the old broken button.
    stub_workspace()
    _absent_but_signable(_install(monkeypatch, _GoTrue()))
    assert client.post("/api/auth/demo").status_code == 200


def test_demo_route_never_sends_the_service_role_key_to_the_browser(
    monkeypatch, supabase_auth_env, stub_workspace
):
    stub_workspace()
    gotrue = _GoTrue()
    _absent_but_signable(gotrue)
    _install(monkeypatch, gotrue)

    response = client.post("/api/auth/demo")

    assert SERVICE_ROLE not in response.text
    assert SERVICE_ROLE not in json.dumps(response.json())


def test_demo_route_is_unavailable_without_supabase(monkeypatch):
    # With the local issuer there is no remote project to provision a tenant in,
    # and inventing one here would hand out a session for an account that does
    # not exist. The local mock mode still gets a demo, from the browser.
    response = client.post("/api/auth/demo")
    assert response.status_code == 503
    assert "Supabase" in response.json()["detail"]


def test_demo_route_reports_the_honest_upstream_status(monkeypatch, supabase_auth_env, stub_workspace):
    stub_workspace()
    gotrue = _GoTrue(routes={"/admin/users": _http_error(401, {"msg": "denied"})})
    _install(monkeypatch, gotrue)

    response = client.post("/api/auth/demo")

    assert response.status_code == 401
    assert "denied" not in response.text.lower()


# ------------------------------------------------------------- the display flag


def test_only_the_reserved_address_is_labelled_as_the_demo():
    # The label exists so the UI can say "this is shared sample data". It
    # authorizes nothing, so it is matched on the reserved address rather than
    # costing every /me an extra lookup.
    assert _is_demo_account({"email": DEMO_EMAIL}) is True
    assert _is_demo_account({"email": DEMO_EMAIL.upper()}) is True
    assert _is_demo_account({"email": "  " + DEMO_EMAIL + " "}) is True
    assert _is_demo_account({"email": "someone@example.com"}) is False
    assert _is_demo_account({"email": None}) is False
    assert _is_demo_account({}) is False
    assert _is_demo_account(None) is False


def test_me_reports_the_demo_flag_so_a_reload_keeps_it(monkeypatch, supabase_auth_env, stub_workspace):
    # The browser asks the server, rather than remembering, so a demo visitor who
    # reloads is not silently shown an anonymous-looking workspace.
    stub_workspace()
    gotrue = _GoTrue(
        routes={
            "/admin/users/{0}".format(DEMO_USER_ID): {
                "id": DEMO_USER_ID,
                "email": DEMO_EMAIL,
                "user_metadata": {
                    "name": demo_workspace.DEMO_DISPLAY_NAME,
                    "business_name": demo_workspace.DEMO_BUSINESS_NAME,
                },
            }
        }
    )
    _install(monkeypatch, gotrue)

    response = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {_token(DEMO_USER_ID, email=DEMO_EMAIL)}"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["is_demo"] is True
    assert body["user"]["id"] == DEMO_USER_ID


def test_me_does_not_label_a_real_account_as_the_demo(monkeypatch, supabase_auth_env):
    gotrue = _GoTrue(
        routes={
            "/admin/users/real-user": {
                "id": "real-user",
                "email": "someone@example.com",
                "user_metadata": {"name": "Someone"},
            }
        }
    )
    _install(monkeypatch, gotrue)

    response = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {_token('real-user', email='someone@example.com')}"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["is_demo"] is False


# ------------------------------------------------------------------ the button

# The project has no JavaScript test runner, so the button is checked by reading
# its source. What matters is the wiring, not the markup: the handler has to
# reach the server for a session rather than filling the form in, and the form's
# own state has to stay out of it.
LOGIN_JSX = Path(__file__).resolve().parents[1] / "frontend" / "src" / "pages" / "auth" / "LoginPage.jsx"
AUTH_SERVICE = (
    Path(__file__).resolve().parents[1] / "frontend" / "src" / "services" / "authService.js"
)


@pytest.fixture(scope="module")
def login_source() -> str:
    assert LOGIN_JSX.exists(), f"login page not found at {LOGIN_JSX}"
    return LOGIN_JSX.read_text(encoding="utf-8")


def test_the_demo_button_asks_the_server_for_a_session(login_source: str) -> None:
    # The bug being fixed: the button only pre-filled the form, so submitting it
    # sent a mock-only credential to a real identity provider and came back
    # "Email or password is incorrect". One click has to mean one signed-in
    # session.
    assert "handleDemo" in login_source
    handler = re.search(r"const handleDemo = async \(\) => \{(.*?)\n  \};", login_source, re.DOTALL)
    assert handler, "handleDemo is not defined on the login page"
    body = handler.group(1)
    assert "enterDemo()" in body
    assert "navigate('/app')" in body
    # No credential is typed in, because there is no credential to type.
    assert "setEmail" not in body
    assert "setPassword" not in body
    assert "DEMO_CREDENTIALS" not in body


def test_the_button_survives_even_though_the_credential_import_is_gone(login_source: str) -> None:
    # Leaving the old pre-fill in place as dead code is how this regresses: the
    # label would still look right while the click did nothing.
    assert "fillDemo" not in login_source
    assert "DEMO_CREDENTIALS" not in login_source
    assert "onClick={handleDemo}" in login_source


def test_the_service_only_uses_the_demo_password_in_local_mode() -> None:
    source = AUTH_SERVICE.read_text(encoding="utf-8")
    enter = re.search(
        r"export async function enterDemo\(\) \{(.*?)\n\}", source, re.DOTALL
    )
    assert enter, "enterDemo is not exported from the auth service"
    body = enter.group(1)
    assert "backendRequest('/demo'" in body
    # The local mock is the one issuer that has a demo credential, so it is the
    # only branch allowed to name it. Handing it to the backend would be asking
    # the real identity provider for a password nobody chose.
    assert body.count("DEMO_CREDENTIALS") == 1, (
        "DEMO_CREDENTIALS must appear once, in the local-mock branch only"
    )
    assert "login(DEMO_CREDENTIALS)" in body.split("if (REMOTE_AUTH)")[1]
