"""The public demo workspace: one dedicated, provisioned tenant.

A visitor who has never signed up needs to see the product work. The button that
used to do that only pre-filled the login form with a credential that existed in
the browser's own local store, so against a real backend it failed with "Email or
password is incorrect" — there was no such account to sign in to.

This module owns a **single, fixed demo tenant** and hands out a real session
for it. The important properties, and why each one is here:

* **The demo is an ordinary tenant.** It is a real GoTrue user with a real
  ``sub``, so the token it receives is verified by the same ``require_auth`` as
  any other and every V2 request is scoped to it by the same subject check. No
  route, no special case, no bypass: a demo principal can reach the demo tenant
  and nothing else, exactly as a signed-up user can reach only their own rows.

* **It cannot be pointed at another account.** The route takes no address, no
  user id and no credential, so it can only ever return the demo tenant. It is
  not a general "mint a session" primitive.

* **The demo password is random and server-side only.** It is minted per process,
  never sent to a browser, and rewritten on every start, so the account has no
  stable, guessable credential — the endpoint is the only way in. That keeps the
  demo out of reach of anyone who merely knows its address.

* **The demo data is separate from real data.** It lives under the demo tenant's
  own id in the same tables everything else uses, seeded only from the canonical
  on-disk raw store, and the tenant is flagged ``is_demo`` in its metadata so it
  is identifiable rather than anonymous.

Real accounts are untouched by any of this: they still authenticate with their own
credentials, and nothing here can read or write their rows.
"""

from __future__ import annotations

import logging
import secrets
import threading
from dataclasses import dataclass
from typing import Any, Dict, Optional

from backend import supabase_auth
from backend.config import Settings
from backend.tenant import DEMO_EMAIL

_logger = logging.getLogger(__name__)

#: Metadata flag written on the demo auth user. It marks the account so an
#: operator can recognise it, and so nothing can mistake it for a real signup.
DEMO_FLAG = "is_demo"

#: What the demo tenant is called in the UI. Deliberately not a real-looking
#: person, so a visitor is never confused about whose workspace they are in.
DEMO_DISPLAY_NAME = "Demo Workspace"
DEMO_BUSINESS_NAME = "TerraMart Retail"

#: Guards the one-time provisioning below. Two visitors arriving together must
#: not both decide the user is missing and race to create it.
_lock = threading.Lock()
_identity: Optional["_DemoIdentity"] = None


@dataclass(frozen=True)
class _DemoIdentity:
    """The demo account's id and its in-memory password."""

    user_id: str
    password: str


def reset_cached_identity() -> None:
    """Forget the cached demo identity so the next call re-resolves it.

    Only the test suite needs this; production re-resolves on its own when a
    request finds the cached password no longer works.
    """

    global _identity
    with _lock:
        _identity = None


def _resolve_identity(settings: Settings) -> _DemoIdentity:
    """Find, or create, the demo auth user and hold its password in memory."""

    global _identity
    with _lock:
        if _identity is not None:
            return _identity

        # A fresh random password every process. Nothing outside this module ever
        # sees it, and a previous process's value is replaced, so a stale copy
        # left in a crash dump or a log cannot be replayed later.
        password = secrets.token_urlsafe(32)
        user_id = supabase_auth.find_user_id_by_email(settings, DEMO_EMAIL)
        if user_id is None:
            created = supabase_auth.create_confirmed_user(
                settings,
                DEMO_EMAIL,
                password,
                {
                    "name": DEMO_DISPLAY_NAME,
                    "business_name": DEMO_BUSINESS_NAME,
                    DEMO_FLAG: True,
                },
            )
            user_id = created["id"]
            _logger.info("Provisioned the demo workspace account.")
        else:
            # Re-key the existing account rather than trusting the old password,
            # so the demo identity is never reachable with a known credential.
            supabase_auth.set_password(settings, user_id, password)

        _identity = _DemoIdentity(user_id=user_id, password=password)
        return _identity


def _ensure_seeded(user_id: str) -> Dict[str, int]:
    """Give the demo tenant its sample data, once.

    The rows come from :func:`backend.tenant.seed_canonical_demo`, the same
    canonical walk every "load sample data" action already uses, and land in the
    demo tenant's own workspace through the same durable write path — so the demo
    is separated from real tenants by its tenant id, not by a different storage
    mechanism.

    Seeding is skipped when the workspace already holds data, which makes repeat
    visits cheap, and it re-runs if a visitor empties the catalog, so a demo left
    broken heals on the next visit instead of staying broken forever.
    """

    from backend.tenant import seed_canonical_demo

    # Imported here rather than at module scope: the workspace registry lives in
    # the V2 router, and the auth router imports this module. A deferred import
    # keeps the two from forming an import-time cycle.
    from backend.routers.v2 import get_workspace

    ws = get_workspace(user_id, email=DEMO_EMAIL)
    seeded = {"products": len(ws.products), "sales_rows": len(ws.sales_records)}
    if ws.products or ws.sales_records:
        return seeded
    written = seed_canonical_demo(ws)
    _logger.info("Seeded the demo workspace with %s sales rows.", written)
    return {"products": len(ws.products), "sales_rows": len(ws.sales_records)}


def _open_demo_session(settings: Settings) -> Dict[str, Any]:
    """Sign in to the demo tenant and make sure it has data."""

    identity = _resolve_identity(settings)
    session = supabase_auth.sign_in(settings, DEMO_EMAIL, identity.password)
    if not session.get("access_token"):
        raise supabase_auth.SupabaseAuthError(
            "GoTrue issued no session for the demo workspace.",
            status_code=503,
        )
    seeded = _ensure_seeded(identity.user_id)
    session["is_demo"] = True
    session["seeded"] = seeded
    return session


def demo_session(settings: Settings) -> Dict[str, Any]:
    """Return a login-shaped session for the demo tenant, seeding it if empty.

    The password grant is used deliberately: it is the one GoTrue flow that both
    provisions and authenticates an account, so the demo needs no bespoke token
    format and gets a genuine refresh token that the browser renews through the
    ordinary session code.
    """

    try:
        return _open_demo_session(settings)
    except supabase_auth.SupabaseAuthError as exc:
        # Only a refused credential is retried. An unreachable or misconfigured
        # project is re-raised untouched, so a real outage is not reported as
        # though the demo were merely mistyped.
        if not supabase_auth.credentials_rejected(exc):
            raise

    # The password held in memory no longer works. A visitor can change the demo
    # account's own password from the Settings page, and a project restored from
    # a backup would invalidate it too. Either way the account is ours to re-key,
    # so the demo repairs itself instead of failing until someone restarts the
    # server. One attempt only: a second failure is reported.
    _logger.info("The cached demo credential was refused; re-keying the demo account.")
    reset_cached_identity()
    return _open_demo_session(settings)
