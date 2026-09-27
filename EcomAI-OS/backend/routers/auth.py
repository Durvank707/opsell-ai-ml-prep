"""Authentication endpoints.

Two issuers live behind one router, and the split is deliberate:

* ``signup``/``login``/``me``/``logout`` are the optional **local** development
  issuer. They are gated on ``LOCAL_AUTH_ENABLED=true`` and fail closed for
  Supabase and production configuration in :class:`backend.config.Settings`.
* The six **account** actions (password reset, profile, password change,
  sign-out-everywhere, account deletion) are backed by **Supabase Auth**. They
  exist because the frontend offered those actions and there was nowhere for
  them to go: the local issuer has no reset-token, revocation, or deletion
  story, and inventing one would be a second, weaker identity system.

The account routes are gated on Supabase Auth being configured, not on the local
issuer, so they work under ``USE_SUPABASE=true`` where the local routes 503.

The service-role key stays in :mod:`backend.supabase_auth` and is never
serialized into a response. The browser only ever presents the credential it
already holds: its own access token, or a recovery token from a reset link.
"""

from __future__ import annotations

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

router = APIRouter(prefix="/api/auth", tags=["Authentication"])

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
                    query={
                        "user_id": f"eq.{user_id}",
                        "return": "representation",
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


# ---------------------------------------------------------------- local issuer


@router.post("/signup", status_code=status.HTTP_201_CREATED)
async def signup(payload: SignupRequest):
    settings = _settings_or_503()
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
    return {"user": user, "access_token": token, "token_type": "bearer"}


@router.post("/login")
async def login(payload: LoginRequest):
    settings = _settings_or_503()
    try:
        store = get_store(settings)
        user = store.authenticate(email=payload.email, password=payload.password)
        token = issue_access_token(user, settings)
    except InvalidCredentialsError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except LocalAuthError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"user": user, "access_token": token, "token_type": "bearer"}


@router.get("/me")
async def me(principal: AuthPrincipal = Depends(require_auth)):
    settings = _settings_or_503()
    user = get_store(settings).get_user(principal.user_id or "")
    if user is None:
        raise HTTPException(status_code=401, detail="The local account no longer exists.")
    return {"user": user}


@router.post("/logout")
async def logout(principal: AuthPrincipal = Depends(require_auth)):
    # Access tokens are short-lived and stateless. The client clears its token;
    # this endpoint makes that intent explicit and leaves an auth audit hook.
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
