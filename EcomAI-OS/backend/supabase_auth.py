"""Supabase Auth (GoTrue) operations for the account-management endpoints.

The data layer already talks to Supabase over PostgREST using the service-role
key, but nothing here touched GoTrue: signup/login were local-issuer only, so
the six account actions the frontend offers had nowhere to go. This module is
the server-side GoTrue client they needed.

Deliberate properties, matching ``backend.supabase``:

* No Supabase SDK. ``urllib`` keeps importing the backend cheap and keeps a
  browser-reachable dependency out of the process.
* The service-role key never leaves this module. It is attached to a header and
  never serialized into a response, a log line, or an exception message.
* Redirects are refused (``_SUPABASE_OPENER``), so a redirect can never carry
  the service-role header to a host the project does not own.
* Upstream error bodies are not echoed verbatim. GoTrue messages are lifted
  through a small allowlist of known-safe fields and length-capped, because an
  error body can echo request values.

Identity note: for a token this project verifies, ``sub`` is the tenant id and
it must equal the configured tenant claim. Supabase Auth issues UUID subjects,
so the subject a caller presents is the id these admin calls address. The
caller-supplied ``user_id`` query parameter is never consulted for any of this.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request

from backend.config import Settings
from backend.supabase import (
    _MAX_ERROR_BODY,
    _request_timeout,
    _service_role_creds,
    _urlopen,
)

_logger = logging.getLogger(__name__)

# GoTrue's own messages are not a stable contract, so only a few are allowed
# through verbatim. Everything else becomes a generic, still-honest sentence.
_PASSTHROUGH_MESSAGES = frozenset(
    {
        "Email not confirmed",
        "Email rate limit exceeded",
        "New password should be different from the old password.",
        "Password should be at least 6 characters",
        "Unable to validate email",
        "User already registered",
    }
)

_GENERIC_BY_STATUS = {
    400: "Supabase Auth rejected the request.",
    401: "Supabase Auth could not verify those credentials.",
    403: "Supabase Auth refused the request.",
    404: "No Supabase Auth account is linked to this identity.",
    422: "Supabase Auth rejected the submitted values.",
    429: "Too many attempts. Please wait a moment and try again.",
}

_MAX_DETAIL = 240
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class SupabaseAuthError(RuntimeError):
    """A GoTrue call failed. The message is safe to return to the caller.

    ``status_code`` carries the upstream status when one was received so the
    router can report the honest code instead of flattening every failure to a
    single 500. It is never the upstream body.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        upstream_code: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.upstream_code = upstream_code


def supabase_auth_configured(settings: Settings) -> bool:
    """True when GoTrue admin calls are possible with this configuration.

    Needs ``USE_SUPABASE=true``, a real project URL, and a real service-role
    key. The publishable key is needed too, because verifying a caller's
    current password is a user-level grant, not an admin call.
    """

    if not settings.use_supabase:
        return False
    try:
        creds = _service_role_creds()
    except Exception:  # noqa: BLE001 - absence, not failure
        return False
    return bool(creds.get("service_role_key") and settings.supabase_publishable_key)


def normalize_email(value: Any) -> str:
    """Return a canonical address or raise ``ValueError``."""

    email = str(value or "").strip()
    if len(email) > 320 or not _EMAIL_RE.match(email):
        raise ValueError("A valid email address is required.")
    return email.casefold()


def _auth_url(creds: Mapping[str, str], path: str, query: Optional[Mapping[str, Any]]) -> str:
    if not path.startswith("/") or ".." in path or " " in path:
        raise SupabaseAuthError("Refusing to build a Supabase Auth path.")
    url = str(creds["url"]).rstrip("/") + "/auth/v1" + path
    if query:
        url += "?" + urlencode(
            {k: v for k, v in query.items() if v is not None}, doseq=True
        )
    return url


def _safe_detail(payload: Any, status: int) -> str:
    """Lift one safe, bounded message out of a GoTrue error body."""

    candidates: list = []
    if isinstance(payload, Mapping):
        for field in ("msg", "message", "error_description", "error"):
            value = payload.get(field)
            if isinstance(value, str):
                candidates.append(value)
    for candidate in candidates:
        text = candidate.strip()
        if text in _PASSTHROUGH_MESSAGES:
            return text
    return _GENERIC_BY_STATUS.get(status, "Supabase Auth could not complete the request.")


def _auth_request(
    method: str,
    path: str,
    *,
    settings: Settings,
    query: Optional[Mapping[str, Any]] = None,
    body: Optional[Any] = None,
    token: Optional[str] = None,
    admin: bool = False,
) -> Any:
    """Issue one bounded GoTrue request.

    ``admin`` selects the service-role key for ``/admin/*`` paths. Everything
    else is a user-level call, which must carry the publishable key plus
    whichever user credential (access token or recovery token) authorizes it.
    Using the service-role key on a user-level path would let a caller act with
    privileges their own token does not have.
    """

    creds = _service_role_creds()
    if admin:
        headers = {
            "apikey": creds["service_role_key"],
            "Authorization": f"Bearer {creds['service_role_key']}",
        }
    else:
        publishable = str(settings.supabase_publishable_key or "").strip()
        if not publishable:
            raise SupabaseAuthError(
                "Supabase Auth is not configured on the server.",
                status_code=503,
            )
        headers = {"apikey": publishable}
        if token:
            headers["Authorization"] = f"Bearer {token}"
    headers["Accept"] = "application/json"

    data = None
    if body is not None:
        try:
            data = json.dumps(
                body, allow_nan=False, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise SupabaseAuthError("The request could not be encoded as JSON.") from exc
        headers["Content-Type"] = "application/json"

    request = Request(
        _auth_url(creds, path, query),
        data=data,
        headers=headers,
        method=method.upper(),
    )

    try:
        with _urlopen(request, timeout=_request_timeout()) as response:
            raw = response.read()
    except HTTPError as exc:
        try:
            raw_error = exc.read(_MAX_ERROR_BODY)
        except (AttributeError, OSError):
            raw_error = b""
        payload: Any = None
        if raw_error:
            try:
                payload = json.loads(raw_error.decode("utf-8", errors="replace"))
            except (TypeError, ValueError):
                payload = None
        detail = _safe_detail(payload, exc.code)[:_MAX_DETAIL]
        upstream = None
        if isinstance(payload, Mapping) and isinstance(payload.get("error_code"), str):
            upstream = payload["error_code"][:64]
        raise SupabaseAuthError(
            detail, status_code=exc.code, upstream_code=upstream
        ) from None
    except (URLError, OSError, TimeoutError) as exc:
        raise SupabaseAuthError(
            "Supabase Auth could not be reached; no change was made.",
            status_code=503,
        ) from exc

    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8", errors="replace"))
    except (TypeError, ValueError) as exc:
        raise SupabaseAuthError(
            "Supabase Auth returned an unreadable response; no change was assumed.",
            status_code=503,
        ) from exc


# ------------------------------------------------------------------ operations


def _user_payload(raw: Any) -> Dict[str, str]:
    """Project a GoTrue user onto the shape the frontend already consumes.

    ``local_auth`` returns ``id``/``sub``/``email``/``name``/``businessName``
    and the frontend types those names, so the two issuers agree on the wire.
    """

    record = raw if isinstance(raw, Mapping) else {}
    metadata = record.get("user_metadata")
    meta = metadata if isinstance(metadata, Mapping) else {}
    user_id = str(record.get("id") or "").strip()
    return {
        "id": user_id,
        "sub": user_id,
        "email": str(record.get("email") or ""),
        "name": str(meta.get("name") or meta.get("full_name") or ""),
        "businessName": str(meta.get("business_name") or meta.get("businessName") or ""),
    }


def get_user(settings: Settings, user_id: str) -> Dict[str, str]:
    """Read one auth user by its Supabase id (the caller's ``sub``)."""

    raw = _auth_request(
        "GET",
        f"/admin/users/{quote(str(user_id), safe='')}",
        settings=settings,
        admin=True,
    )
    return _user_payload(raw)


def update_user(
    settings: Settings,
    user_id: str,
    *,
    name: Optional[str] = None,
    business_name: Optional[str] = None,
    email: Optional[str] = None,
) -> Dict[str, str]:
    """Update profile fields on one auth user.

    Only the fields actually supplied are sent, so a caller changing their
    display name cannot silently clear the business name. GoTrue merges
    ``user_metadata`` keys rather than replacing the object.
    """

    metadata: Dict[str, str] = {}
    if name is not None:
        metadata["name"] = name
    if business_name is not None:
        metadata["business_name"] = business_name
    body: Dict[str, Any] = {}
    if metadata:
        body["user_metadata"] = metadata
    if email is not None:
        body["email"] = email
    if not body:
        raise ValueError("No profile changes were supplied.")
    raw = _auth_request(
        "PUT",
        f"/admin/users/{quote(str(user_id), safe='')}",
        settings=settings,
        body=body,
        admin=True,
    )
    return _user_payload(raw)


def set_password(settings: Settings, user_id: str, new_password: str) -> None:
    """Set a user's password directly through the admin API."""

    _auth_request(
        "PUT",
        f"/admin/users/{quote(str(user_id), safe='')}",
        settings=settings,
        body={"password": new_password},
        admin=True,
    )


def delete_user(settings: Settings, user_id: str) -> None:
    """Permanently remove an auth user."""

    _auth_request(
        "DELETE",
        f"/admin/users/{quote(str(user_id), safe='')}",
        settings=settings,
        query={"should_soft_delete": "false"},
        admin=True,
    )


def verify_password(settings: Settings, email: str, password: str) -> Dict[str, str]:
    """Re-authenticate with a password and return the matching user.

    A password change and an account deletion both need proof that the caller
    holds the current password. Rather than adding a second copy of GoTrue's
    hashing to compare against, this asks GoTrue to do what it already does
    and treats its answer as authoritative.

    Failure is a **403**, not a 401, and that distinction is load-bearing. The
    caller is already authenticated; the request is understood and refused,
    which is exactly what 403 means. It also keeps 401 unambiguous: on this API
    a 401 means "the session credential is not acceptable" and is always
    accompanied by ``WWW-Authenticate: Bearer``, which is what lets the browser
    tell a dead session from a wrong password. Reporting a mistyped current
    password as 401 signed the user out instead of telling them to retype it.

    The upstream status is collapsed the same way :func:`sign_in` collapses it,
    so a wrong password and an unknown account are one indistinguishable answer.
    A 429 is passed through: a throttle is not a credential verdict.
    """

    try:
        raw = _auth_request(
            "POST",
            "/token",
            settings=settings,
            query={"grant_type": "password"},
            body={"email": email, "password": password},
        )
    except SupabaseAuthError as exc:
        if _credentials_rejected(exc.status_code):
            raise SupabaseAuthError(
                "The current password is incorrect.", status_code=403
            ) from exc
        raise
    user = raw.get("user") if isinstance(raw, Mapping) else None
    if not isinstance(user, Mapping):
        raise SupabaseAuthError(
            "The current password is incorrect.", status_code=403
        )
    return _user_payload(user)


def apply_recovery_token(settings: Settings, token: str, new_password: str) -> None:
    """Set a new password using a recovery token from a reset link, once.

    The recovery token is itself the credential, so it travels as the bearer
    rather than through ``require_auth``: the caller holds no session yet.

    GoTrue does not treat a recovery session as single-use. A token stays able
    to set a password for its whole lifetime (an hour by default), and each
    call overwrites the last, so a link that leaks -- forwarded mail, shared
    history, a proxy log -- remains a working account-takeover credential long
    after the real user has reset their password and believes the link is
    spent. Verified against GoTrue: three consecutive ``PUT /user`` calls on
    one recovery session all return 200, and the last password wins.

    So the session is revoked as soon as the password is set, using the very
    token the caller presented. A replay then fails closed with GoTrue's
    ``403 session_not_found``. This is the same ``POST /logout`` revocation
    ``sign_out`` already performs, and it needs no privileged credential: the
    recovery token authorises revoking itself.

    Revocation happens only after the password is accepted, and a failure to
    revoke is logged rather than raised. The password has already changed by
    then, so failing the request would tell the user their reset did not happen
    when it did -- and a still-valid link is the lesser problem next to a user
    who never learns their new password works.
    """

    _auth_request(
        "PUT",
        "/user",
        settings=settings,
        body={"password": new_password},
        token=token,
    )
    try:
        _auth_request("POST", "/logout", settings=settings, token=token)
    except SupabaseAuthError as exc:
        # The password is already set. Report the weak outcome for an operator
        # and let the caller believe the reset worked.
        _logger.warning(
            "Password was reset but the recovery session could not be revoked, "
            "so that reset link stays replayable until it expires: %s", exc
        )


def request_password_recovery(
    settings: Settings, email: str, redirect_to: str
) -> None:
    """Ask GoTrue to email a password-recovery link.

    This is a public endpoint authenticated with the publishable key, not an
    admin call, so no privileged credential is involved in starting a reset.

    Account existence is deliberately not observable to the caller. GoTrue
    answers 200 for a registered address and, depending on the project's
    "leak protection" setting, may answer 4xx for an unknown one. Every 4xx is
    swallowed here so both cases look identical from outside. A 5xx or a
    transport failure is *not* swallowed: those mean the mail genuinely may not
    have gone out, and reporting success for that would tell a user to wait for
    an email that will never arrive.

    The swallow is uniform but it is not silent. A 4xx from ``/recover`` is
    ambiguous between "no such account" (expected, privacy-preserving) and a
    real fault such as a ``redirect_to`` the project's allow-list rejects, in
    which case no mail is ever sent. Logging the reason is what separates the
    two for an operator, because the HTTP response deliberately cannot.
    """

    try:
        _auth_request(
            "POST",
            "/recover",
            settings=settings,
            body={"email": email, "redirect_to": redirect_to},
        )
    except SupabaseAuthError as exc:
        status = exc.status_code
        if status is not None and 400 <= status < 500:
            _logger.warning(
                "Supabase Auth declined a recovery request with HTTP %s (%s). "
                "The caller was told the same thing either way. If this is not "
                "an unknown address, check that PASSWORD_RESET_REDIRECT_URL is "
                "allow-listed under Authentication > URL Configuration.",
                status,
                exc,
            )
            return  # unknown address, already-confirmed, or rate limited
        raise


def sign_out_other_sessions(settings: Settings, access_token: str) -> None:
    """Revoke every refresh token except the caller's own.

    ``scope=others`` is GoTrue's own "log out everywhere else" primitive. The
    caller's access token is short-lived and stateless, so what actually
    matters is that the refresh tokens backing it stop working.
    """

    _auth_request(
        "POST",
        "/logout",
        settings=settings,
        query={"scope": "others"},
        token=access_token,
    )


def sign_out(
    settings: Settings,
    *,
    access_token: Optional[str] = None,
    refresh_token: Optional[str] = None,
) -> None:
    """Revoke the caller's own session, refresh token included.

    An access token is stateless and cannot be withdrawn, but the refresh token
    behind it can, and that is what would otherwise let a browser that signed
    out keep minting new access tokens for the length of the refresh window.

    When the browser holds a refresh token it is sent in the body, because that
    names the exact session to destroy rather than whichever one the bearer
    happens to map to -- the difference matters as soon as a device has more than
    one live session. The access token still has to be sent as the bearer:
    GoTrue answers a body-only request with ``401 no_authorization`` ("This
    endpoint requires a valid Bearer token") and revokes nothing, which would
    leave the caller believing a session was destroyed that is still live.

    That makes the access token a requirement, so a caller whose access token
    has expired cannot revoke this way. The browser is responsible for renewing
    before signing out; the failure is not hidden if it does not.

    With neither token there is nothing to revoke, and saying so is better than
    issuing a request that is guaranteed to be rejected.
    """

    if not access_token and not refresh_token:
        return
    body = {"refresh_token": refresh_token} if refresh_token else None
    _auth_request(
        "POST",
        "/logout",
        settings=settings,
        token=access_token,
        body=body,
    )


# ------------------------------------------------------------------- sessions


_CREDENTIALS_REJECTED = "Email or password is incorrect."


def _session_payload(raw: Any) -> Dict[str, Any]:
    """Project a GoTrue token response onto the shape the frontend consumes.

    An empty ``access_token`` means GoTrue acted on the account but issued no
    session, which is exactly what a project with "Confirm email" enabled does
    on signup. That is reported as-is rather than dressed up as a sign-in, so
    the caller has to handle the unconfirmed case instead of storing an empty
    credential and discovering the problem on the next protected request.
    """

    record = raw if isinstance(raw, Mapping) else {}
    expires_in = record.get("expires_in")
    if isinstance(expires_in, bool) or not isinstance(expires_in, (int, float)):
        expires_in = None
    return {
        "user": _user_payload(record.get("user")),
        "access_token": str(record.get("access_token") or "").strip(),
        "refresh_token": str(record.get("refresh_token") or "").strip(),
        "token_type": str(record.get("token_type") or "bearer").strip() or "bearer",
        "expires_in": int(expires_in) if expires_in is not None else None,
    }


def _credentials_rejected(status: Optional[int]) -> bool:
    """Whether an upstream status means "these credentials are not valid"."""

    return status is not None and 400 <= status < 500 and status != 429


def sign_in(settings: Settings, email: str, password: str) -> Dict[str, Any]:
    """Exchange an address and password for a session.

    Every credential failure is reported as one 401, whatever GoTrue actually
    said. Upstream separates an unknown address from a wrong password only in
    wording, and a project with "Confirm email" enabled answers an unconfirmed
    account differently from an unknown one -- any of which would let a caller
    enumerate which addresses have accounts. A 429 is passed through as a 429,
    because a throttle is neither a credential verdict nor a secret, and
    flattening it would hide a real limit from the user.

    "Check your inbox" guidance is deliberately not produced here. It belongs to
    signup, where the address cannot already belong to somebody else.
    """

    try:
        raw = _auth_request(
            "POST",
            "/token",
            settings=settings,
            query={"grant_type": "password"},
            body={"email": email, "password": password},
        )
    except SupabaseAuthError as exc:
        if _credentials_rejected(exc.status_code):
            raise SupabaseAuthError(_CREDENTIALS_REJECTED, status_code=401) from None
        raise
    session = _session_payload(raw)
    if not session["access_token"]:
        # A 200 with no token is not a usable session. Reporting it as one would
        # leave the caller holding an empty credential.
        raise SupabaseAuthError(
            "Supabase Auth did not issue a session for those credentials.",
            status_code=401,
        )
    return session


def sign_up(
    settings: Settings,
    email: str,
    password: str,
    metadata: Optional[Mapping[str, str]] = None,
) -> Dict[str, Any]:
    """Create an account, and return a session when GoTrue issues one."""

    body: Dict[str, Any] = {"email": email, "password": password}
    if metadata:
        # ``data`` becomes GoTrue's user_metadata. Only ever supplied by the
        # server from a validated request model, never echoed from the caller.
        body["data"] = {str(k): str(v) for k, v in metadata.items()}
    raw = _auth_request("POST", "/signup", settings=settings, body=body)
    session = _session_payload(raw)
    if not session["user"]["id"]:
        raise SupabaseAuthError(
            "Supabase Auth did not return an account for that signup.",
            status_code=502,
        )
    return session


def refresh_session(settings: Settings, refresh_token: str) -> Dict[str, Any]:
    """Trade a refresh token for a fresh access token.

    A refresh token is a long-lived credential, so every failure here is
    reported as one 401 whatever upstream called it: a token GoTrue does not
    recognise must not be distinguishable from one it has revoked.
    """

    try:
        raw = _auth_request(
            "POST",
            "/token",
            settings=settings,
            query={"grant_type": "refresh_token"},
            body={"refresh_token": refresh_token},
        )
    except SupabaseAuthError as exc:
        if _credentials_rejected(exc.status_code):
            raise SupabaseAuthError(
                "This session is no longer valid. Please sign in again.",
                status_code=401,
            ) from None
        raise
    session = _session_payload(raw)
    if not session["access_token"]:
        raise SupabaseAuthError(
            "Supabase Auth did not issue a session for that refresh token.",
            status_code=401,
        )
    return session
