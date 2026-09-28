"""Authentication endpoints.

Two issuers live behind one router, and they are mutually exclusive in
configuration: ``LOCAL_AUTH_ENABLED=true`` for the local development issuer,
``USE_SUPABASE=true`` for Supabase Auth. :func:`_issuer` picks between them, so
there is never a tie to break and never a fallback from one to the other.

* ``signup``/``login``/``refresh``/``me``/``logout`` are the **session** routes.
  They work with whichever issuer is configured and return the same envelope
  either way, so switching identity providers is a configuration change.
* The six **account** actions (password reset, profile, password change,
  sign-out-everywhere, account deletion) are backed by **Supabase Auth** only.
  They exist because the frontend offered those actions and there was nowhere
  for them to go: the local issuer has no reset-token, revocation, or deletion
  story, and inventing one would be a second, weaker identity system.

The account routes are gated on Supabase Auth being configured rather than on
the local issuer, so they are unavailable -- with an honest 503 -- under a
local-only deployment.

The service-role key stays in :mod:`backend.supabase_auth` and is never
serialized into a response. The browser only ever presents the credential it
already holds: its own access token, its own refresh token, or a recovery token
from a reset link. Signing up and signing in use the publishable key only, so no
privileged credential is involved in establishing a session.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from backend import supabase_auth
from backend.auth import AuthPrincipal, require_auth
from backend.config import Settings
from backend.local_auth import (
    DuplicateEmailError,
    InvalidCredentialsError,
    LocalAuthError,
    get_store,
    issue_access_token,
)
from backend.supabase_auth import SupabaseAuthError
from backend.tenant import DEMO_EMAIL

router = APIRouter(prefix="/api/auth", tags=["Authentication"])
_logger = logging.getLogger(__name__)

MIN_PASSWORD = 8
MAX_PASSWORD = 256

# Reading the raw bearer is needed by exactly one route: signing out other
# sessions has to forward the caller's own access token to Supabase Auth, and
# `AuthPrincipal` deliberately never carries the token itself.
_BEARER = HTTPBearer(auto_error=False)


def _bearer_credentials(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_BEARER),
):
    return credentials


# One narrow column per table, used only to size the rows a DELETE reports back.
# Returning whole rows here would mean pulling every deleted sale across the
# wire just to count it.
_PURGE_PROBE_COLUMN = {
    "sales": "date",
    "products": "product_id",
    "audit_entries": "id",
}
_PURGE_PAGE = 500
_PURGE_MAX_PAGES = 2_000  # a million rows; a guard, not an expected limit


def _is_already_gone(status_code: Optional[int]) -> bool:
    """Whether an upstream refusal means "there was nothing to revoke".

    A 4xx from GoTrue on sign-out means it could not find the session. That is
    the desired end state -- the credential is not usable -- so it is not an
    error. Only a 5xx or a transport error leaves the outcome unknown.
    """

    return status_code is not None and 400 <= status_code < 500


def _purge_tenant_rows(user_id: str) -> int:
    """Delete a departing tenant's business rows. Returns the number removed.

    Deleted in pages until a pass comes back empty, because PostgREST caps how
    many rows one request returns and a single un-paginated DELETE can leave
    rows behind while still reporting success. The loop is what makes the count
    true: it stops on the first short-or-empty page, and if a tenant somehow
    exceeds the page guard it raises rather than reporting a clean sweep it
    did not perform.

    Best-effort per table: an unreachable Supabase is reported rather than
    hidden, but a failure on one table must not strand the others, so each is
    attempted and the first problem is re-raised after the rest have run.
    """

    from backend.supabase import _ALLOWED_TABLES, _request, supabase_enabled

    if not supabase_enabled():
        return 0

    removed = 0
    first_error: Optional[Exception] = None
    for table in sorted(_ALLOWED_TABLES):
        try:
            for _ in range(_PURGE_MAX_PAGES):
                rows = _request(
                    "DELETE",
                    table=table,
                    # `return` is a Prefer header, not a query parameter. As a
                    # query parameter PostgREST reads it as a filter named
                    # "return" and rejects the whole request with PGRST100, which
                    # would turn every purge into a reported failure. The
                    # representation is what makes the paging count possible.
                    prefer="return=representation",
                    query={
                        "user_id": f"eq.{user_id}",
                        "select": _PURGE_PROBE_COLUMN[table],
                        "order": f"{_PURGE_PROBE_COLUMN[table]}.asc",
                        "limit": str(_PURGE_PAGE),
                    },
                )
                page = len(rows) if isinstance(rows, list) else 0
                removed += page
                if page < _PURGE_PAGE:
                    break
            else:
                raise RuntimeError(
                    f"Refusing to report a clean deletion of {table}: more than "
                    f"{_PURGE_MAX_PAGES * _PURGE_PAGE} rows remained."
                )
        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
            first_error = first_error or exc
    if first_error is not None:
        raise first_error
    return removed


class SignupRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=256)
    fullName: str = Field(default="", max_length=120)
    businessName: str = Field(default="", max_length=160)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=256)


class PasswordResetRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class PasswordResetConfirm(BaseModel):
    # The recovery token from the emailed link. It is a credential, not an id.
    token: str = Field(min_length=1, max_length=4096)
    password: str = Field(min_length=MIN_PASSWORD, max_length=MAX_PASSWORD)


class ProfileUpdate(BaseModel):
    # Every field is optional and only the supplied ones are written, so a
    # caller renaming themselves cannot clear their business name.
    name: Optional[str] = Field(default=None, max_length=120)
    businessName: Optional[str] = Field(default=None, max_length=160)
    email: Optional[str] = Field(default=None, max_length=320)


class PasswordChange(BaseModel):
    currentPassword: str = Field(min_length=1, max_length=MAX_PASSWORD)
    newPassword: str = Field(min_length=MIN_PASSWORD, max_length=MAX_PASSWORD)


class AccountDeletion(BaseModel):
    password: str = Field(min_length=1, max_length=MAX_PASSWORD)


class SessionRefresh(BaseModel):
    # Issued alongside the access token at sign-in. Long-lived, so it is a
    # credential: it is never logged, never echoed, and never accepted from a
    # query string.
    refreshToken: str = Field(min_length=1, max_length=4096)


class SessionLogout(BaseModel):
    # Optional so that a caller with no refresh token -- the local issuer, or an
    # older client -- can still sign out. It is the credential that actually
    # gets revoked, so it is forwarded to GoTrue and never used for anything else.
    refreshToken: Optional[str] = Field(default=None, max_length=4096)


def _issuer(settings: Settings) -> str:
    """Decide which identity provider owns the session routes.

    ``LOCAL_AUTH_ENABLED`` and ``USE_SUPABASE`` are mutually exclusive in
    configuration, so this never has to break a tie: exactly one issuer is
    available, and reporting "not configured" when neither is keeps the routes
    failing closed rather than falling through to a provider that holds no
    accounts.
    """

    if supabase_auth.supabase_auth_configured(settings):
        return "supabase"
    if settings.local_auth_enabled:
        return "local"
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
            "No identity provider is configured. Enable the local issuer with "
            "LOCAL_AUTH_ENABLED=true, or Supabase Auth with USE_SUPABASE=true."
        ),
    )


def _session_or_503():
    try:
        settings = Settings()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured on the server.",
        ) from exc
    return settings, _issuer(settings)


def _settings_or_503() -> Settings:
    try:
        settings = Settings()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured on the server.",
        ) from exc
    if not settings.local_auth_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Local authentication is not enabled.",
        )
    return settings


def _supabase_auth_or_503() -> Settings:
    """Gate the account routes on Supabase Auth, failing closed."""

    try:
        settings = Settings()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured on the server.",
        ) from exc
    if not supabase_auth.supabase_auth_configured(settings):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Supabase Auth is not configured on the server. Account "
                "management needs USE_SUPABASE=true with a project URL, a "
                "publishable key, and a server-side service-role key."
            ),
        )
    return settings


def _auth_error(exc: SupabaseAuthError) -> HTTPException:
    """Report a GoTrue failure at the status it actually deserves.

    Upstream 4xx means the request was wrong and the caller can fix it, so it
    keeps its code. A 5xx or an unreachable Supabase is a 503, because that is
    an upstream outage and not a statement about the caller. Nothing here is
    flattened to a 500, which would send an operator hunting for a bug in this
    service when the fault is upstream.
    """

    code = exc.status_code
    if code is not None and 400 <= code < 500:
        return HTTPException(status_code=code, detail=str(exc))
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
    )


def _call_goTrue(operation, *args, **kwargs):  # noqa: N802 - reads as a call
    try:
        return operation(*args, **kwargs)
    except SupabaseAuthError as exc:
        raise _auth_error(exc) from exc


def _subject(principal: AuthPrincipal) -> str:
    """The auth user's Supabase id, taken only from the verified token.

    The caller-supplied ``user_id`` is never read here: every admin call is
    addressed by the signed subject, so a caller cannot manage another tenant's
    account by naming it.
    """

    user_id = str(principal.user_id or "").strip()
    if not principal.authenticated or not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication is required.",
        )
    return user_id


def _is_demo_account(user: dict) -> bool:
    """Whether this user is the public demo tenant, for display only.

    The flag exists so the interface can tell a visitor they are looking at
    shared sample data rather than their own, which matters because the demo
    workspace is one shared tenant: anything a visitor changes there is not saved
    to an account of theirs.

    It is matched on the reserved demo address rather than on the ``is_demo``
    metadata flag, so answering it needs no extra request. That is sound
    *because this value authorizes nothing*. Every tenant boundary in this
    service is decided by the signed ``sub`` in ``require_auth`` and re-checked by
    ``resolve_tenant_id``; a wrong answer here could at worst mislabel a badge. A
    real account cannot be affected: the demo address is owned by the demo tenant,
    and GoTrue does not allow a second account to register it.
    """

    email = user.get("email") if isinstance(user, dict) else None
    return isinstance(email, str) and email.strip().casefold() == DEMO_EMAIL.casefold()


def _require_current_password(
    settings: Settings, principal: AuthPrincipal, password: str
) -> None:
    """Prove the caller holds the account's current password.

    Both a password change and an account deletion are destructive, and a stolen
    access token should not be enough to perform either. The address is read
    from the verified token rather than the request body so it cannot be
    pointed at a different account.
    """

    email = str(principal.email or "").strip()
    if not email:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "This session carries no email address, so the account cannot "
                "be verified. Please sign in again."
            ),
        )
    try:
        address = supabase_auth.normalize_email(email)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    _call_goTrue(supabase_auth.verify_password, settings, address, password)


# ------------------------------------------------------------------- sessions

# The four routes below work with whichever issuer is configured. Both return
# the same envelope -- ``{user, access_token, refresh_token, token_type}`` -- so
# the frontend has one shape to handle and switching identity providers is a
# configuration change rather than a code change.


@router.post("/signup", status_code=status.HTTP_201_CREATED)
async def signup(payload: SignupRequest):
    settings, issuer = _session_or_503()
    if issuer == "supabase":
        try:
            email = supabase_auth.normalize_email(payload.email)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        metadata = {}
        if payload.fullName:
            metadata["name"] = payload.fullName
        if payload.businessName:
            metadata["business_name"] = payload.businessName
        session = _call_goTrue(
            supabase_auth.sign_up, settings, email, payload.password, metadata
        )
        if not session["access_token"]:
            # The ordinary case: "Confirm email" is on, so GoTrue issues no
            # session here and the user has to verify before they can sign in.
            # Saying so -- with both tokens explicitly empty -- is what makes the
            # client show "check your inbox" instead of storing a credential that
            # fails on its first protected request. Verification is never skipped
            # to save the user a step.
            #
            # GoTrue does not say whether it created an account, so neither does
            # this: it answers 200 for an address that already existed, and
            # claiming an account would be a lie in that case. The client is told
            # to check the inbox and to sign in if it already has an account.
            return {
                "user": session["user"],
                "access_token": "",
                "refresh_token": "",
                "token_type": session["token_type"],
                "confirmation_required": True,
            }
        # Only reachable on a project with autoconfirm enabled. A session that
        # really was issued is passed through, and the client is told the account
        # needs no verification.
        return {**session, "confirmation_required": False}

    try:
        store = get_store(settings)
        user = store.create_user(
            email=payload.email,
            password=payload.password,
            display_name=payload.fullName,
            business_name=payload.businessName,
        )
        token = issue_access_token(user, settings)
    except DuplicateEmailError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LocalAuthError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    # The local issuer mints stateless HS256 tokens with no refresh, so
    # ``refresh_token`` is empty and the client re-authenticates on expiry.
    return {
        "user": user,
        "access_token": token,
        "refresh_token": "",
        "token_type": "bearer",
        "confirmation_required": False,
    }


@router.post("/login")
async def login(payload: LoginRequest):
    settings, issuer = _session_or_503()
    if issuer == "supabase":
        try:
            email = supabase_auth.normalize_email(payload.email)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return _call_goTrue(
            supabase_auth.sign_in, settings, email, payload.password
        )

    try:
        store = get_store(settings)
        user = store.authenticate(email=payload.email, password=payload.password)
        token = issue_access_token(user, settings)
    except InvalidCredentialsError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except LocalAuthError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "user": user,
        "access_token": token,
        "refresh_token": "",
        "token_type": "bearer",
    }


@router.post("/demo")
async def enter_demo_workspace():
    """Open the public demo workspace, without asking for any credentials.

    A visitor who has never signed up still needs to see the product work. The
    button on the login page calls this and lands in a fully populated
    workspace — real catalog, real history, real forecasts — using the same
    dashboard, sales, inventory, recommendation and simulation code as any
    signed-in tenant.

    What this is **not**, deliberately:

    * It takes no address, user id or password, so it can only ever return the
      one fixed demo tenant. It is not a way to obtain a session for an
      arbitrary account.
    * The demo account's password is random, lives only in the server's memory,
      and is rewritten on every start, so the account has no credential anyone
      else could use. Signing in as ``demo@ecomai.app`` through ``/login``
      therefore still fails.
    * The session returned is an ordinary signed token for the demo tenant's own
      subject, so ``require_auth`` and the per-request tenant check treat it
      exactly like any other session. A demo visitor reaches the demo rows and
      nothing else; real tenants are unaffected and remain unreadable and
      unwritable from here.

    With the local identity provider the demo workspace is the seeded store the
    app has always shipped, so the same button keeps working with no Supabase
    project configured.
    """

    settings, issuer = _session_or_503()
    if issuer != "supabase":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "The demo workspace needs the Supabase identity provider. Run "
                "with USE_SUPABASE=true, or explore the seeded local workspace."
            ),
        )
    from backend import demo_workspace

    try:
        return demo_workspace.demo_session(settings)
    except SupabaseAuthError as exc:
        raise _auth_error(exc) from exc


@router.post("/refresh")
async def refresh(payload: SessionRefresh):
    """Exchange a refresh token for a new access token.

    Supabase access tokens last about an hour. Without this a signed-in user is
    dropped at the end of it, and the only way back is a password they may not
    still have. The local issuer has no refresh token, so it answers 503 rather
    than pretending to renew one.
    """

    settings, issuer = _session_or_503()
    if issuer != "supabase":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The local identity provider does not issue refresh tokens.",
        )
    return _call_goTrue(
        supabase_auth.refresh_session, settings, payload.refreshToken
    )


@router.get("/me")
async def me(principal: AuthPrincipal = Depends(require_auth)):
    settings, issuer = _session_or_503()
    user_id = str(principal.user_id or "")
    if issuer == "supabase":
        # Addressed by the signed subject only, so a caller cannot read another
        # account by naming one.
        user = _call_goTrue(supabase_auth.get_user, settings, user_id)
        return {"user": user, "is_demo": _is_demo_account(user)}

    user = get_store(settings).get_user(user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="The local account no longer exists.")
    return {"user": user, "is_demo": _is_demo_account(user)}


@router.post("/logout")
async def logout(
    principal: AuthPrincipal = Depends(require_auth),
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_credentials),
    payload: Optional[SessionLogout] = None,
):
    # Deliberately issuer-agnostic, and deliberately still 200 when no provider
    # is configured: a sign-out that failed would leave a token in the browser
    # with no way to clear it, and clearing it locally is the part that
    # actually matters.
    #
    # A failed *revocation* is not swallowed silently, though. Telling the
    # caller 200 while its refresh token is still live would be a
    # security-relevant lie, so the upstream reason is logged for an operator
    # even though the caller's own sign-out has genuinely succeeded.
    try:
        settings, issuer = _session_or_503()
    except HTTPException:
        return {"ok": True, "user_id": principal.user_id}

    if issuer == "supabase":
        try:
            supabase_auth.sign_out(
                settings,
                access_token=credentials.credentials if credentials is not None else None,
                refresh_token=(payload.refreshToken if payload else None),
            )
        except SupabaseAuthError as exc:
            # GoTrue answers 4xx when the session it was asked to revoke is
            # already gone. That is the outcome this route wanted, not a
            # failure, and it is the normal answer after a password change --
            # which revokes the session itself. Reporting it at warning level
            # made every password change look like a security incident.
            if _is_already_gone(exc.status_code):
                _logger.info(
                    "Sign-out found no live session to revoke (%s). Nothing to "
                    "revoke; the caller is signed out. Reason: %s",
                    exc.status_code,
                    exc,
                )
            else:
                # A 5xx or a transport failure means the outcome is genuinely
                # unknown, so this stays loud: the caller was told it was signed
                # out and that may not be true.
                _logger.warning(
                    "Supabase Auth could not confirm a sign-out revocation (%s). "
                    "The caller is signed out locally, but that refresh token may "
                    "still be usable. Sign-out failures: %s",
                    exc.status_code,
                    exc,
                )
    return {"ok": True, "user_id": principal.user_id}


# ------------------------------------------------------- Supabase Auth account


@router.post("/password-reset")
async def request_password_reset(payload: PasswordResetRequest):
    """Start a password reset by emailing a Supabase Auth recovery link.

    The response is the same for a registered address and an unknown one, so
    this endpoint cannot be used to discover which addresses have accounts.
    """

    settings = _supabase_auth_or_503()
    try:
        email = supabase_auth.normalize_email(payload.email)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    redirect_to = settings.password_reset_redirect_url
    if not redirect_to:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Password reset is not configured: set PASSWORD_RESET_REDIRECT_URL "
                "to this app's /reset-password URL and allow-list it under "
                "Authentication > URL Configuration in the Supabase dashboard."
            ),
        )
    _call_goTrue(
        supabase_auth.request_password_recovery, settings, email, redirect_to
    )
    return {"ok": True, "sent": True}


@router.post("/reset-password")
async def reset_password(payload: PasswordResetConfirm):
    """Complete a reset using the recovery token from the emailed link.

    Unauthenticated on purpose: the recovery token is the credential, and the
    person holding it has no session yet.
    """

    settings = _supabase_auth_or_503()
    token = payload.token.strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="This reset link is invalid or missing its token.",
        )
    _call_goTrue(
        supabase_auth.apply_recovery_token, settings, token, payload.password
    )
    return {"ok": True}


@router.patch("/me")
async def update_profile(
    payload: ProfileUpdate, principal: AuthPrincipal = Depends(require_auth)
):
    """Update the signed-in user's own profile."""

    settings = _supabase_auth_or_503()
    subject = _subject(principal)
    email: Optional[str] = None
    if payload.email is not None:
        try:
            email = supabase_auth.normalize_email(payload.email)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
            ) from exc
    if payload.name is None and payload.businessName is None and email is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No profile changes were supplied.",
        )
    user = _call_goTrue(
        supabase_auth.update_user,
        settings,
        subject,
        name=payload.name,
        business_name=payload.businessName,
        email=email,
    )
    return {"user": user}


@router.post("/change-password")
async def change_password(
    payload: PasswordChange, principal: AuthPrincipal = Depends(require_auth)
):
    """Set a new password after proving the current one."""

    settings = _supabase_auth_or_503()
    _require_current_password(settings, principal, payload.currentPassword)
    if payload.currentPassword == payload.newPassword:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The new password must be different from the current one.",
        )
    _call_goTrue(
        supabase_auth.set_password, settings, _subject(principal), payload.newPassword
    )
    return {"ok": True}


@router.post("/logout-all")
async def logout_all_sessions(
    principal: AuthPrincipal = Depends(require_auth),
    credentials=Depends(_bearer_credentials),
):
    """Revoke every refresh token except the caller's own."""

    settings = _supabase_auth_or_503()
    _subject(principal)
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication is required."
        )
    _call_goTrue(
        supabase_auth.sign_out_other_sessions, settings, credentials.credentials
    )
    return {"ok": True}


@router.delete("/me")
async def delete_account(
    payload: AccountDeletion, principal: AuthPrincipal = Depends(require_auth)
):
    """Permanently delete the signed-in user's account.

    The caller's own business rows are deleted with it. Leaving them would be
    worse than deleting them: every read in this service is scoped to the
    signed tenant, so once the auth user is gone those rows are unreachable
    forever and can never be cleaned up by the person who created them.
    """

    settings = _supabase_auth_or_503()
    subject = _subject(principal)
    _require_current_password(settings, principal, payload.password)
    _call_goTrue(supabase_auth.delete_user, settings, subject)
    try:
        removed = _purge_tenant_rows(subject)
    except Exception as exc:  # noqa: BLE001 - reported, not hidden
        # The account is already gone, so this cannot be undone and the client
        # must not be left thinking the whole deletion failed. Say plainly that
        # the identity is deleted and that stored rows still remain.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Your account was deleted, but this tenant's stored sales, "
                "product, and activity rows could not be removed and need "
                "manual cleanup."
            ),
        ) from exc
    return {"ok": True, "deleted_rows": removed}
