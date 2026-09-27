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
    and treats its answer as authoritative. Failure is reported as a
    ``SupabaseAuthError`` with status 401 and is deliberately
    indistinguishable between an unknown address and a wrong password.
    """

    raw = _auth_request(
        "POST",
        "/token",
        settings=settings,
        query={"grant_type": "password"},
        body={"email": email, "password": password},
    )
    user = raw.get("user") if isinstance(raw, Mapping) else None
    if not isinstance(user, Mapping):
        raise SupabaseAuthError(
            "Supabase Auth did not return an account for those credentials.",
            status_code=401,
        )
    return _user_payload(user)


def apply_recovery_token(settings: Settings, token: str, new_password: str) -> None:
    """Set a new password using a recovery token from a reset link.

    The recovery token is itself the credential, so it travels as the bearer
    rather than through ``require_auth``: the caller holds no session yet.
    """

    _auth_request(
        "PUT",
        "/user",
        settings=settings,
        body={"password": new_password},
        token=token,
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
