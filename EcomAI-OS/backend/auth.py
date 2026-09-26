"""Server-side JWT authentication and tenant identity binding for V2.

The V2 API must not treat a request-body/path/query ``user_id`` as an
identity.  This module verifies a signed bearer token, derives the tenant from
a verified claim (``sub`` by default), and exposes a small FastAPI dependency
for route handlers.

The verifier is dependency-free.  It supports the local HS256 mode as well as
RS256 using a server-configured PEM public key or a tightly bounded JWKS URL.
The token's ``alg`` header is never allowed to choose the algorithm; it must
match the server configuration.  No token/key material is logged or returned.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import math
import os
import re
import time
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from backend.config import Settings


MAX_TOKEN_LENGTH = 16_384
MIN_JWT_SECRET_BYTES = 32
SUPPORTED_JWT_ALGORITHMS = {"HS256", "RS256"}
JWT_ALGORITHM = "HS256"  # backwards-compatible public constant
_BEARER = HTTPBearer(auto_error=False)
_B64_SEGMENT = re.compile(r"^[A-Za-z0-9_-]+$")
_CLAIM_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_RSA_DIGEST_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")
_RSA_MIN_KEY_BITS = 2048


class _NoRedirectHandler(HTTPRedirectHandler):
    """Do not forward configured auth headers through a redirect."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


_JWKS_OPENER = build_opener(_NoRedirectHandler)
_JWKS_CACHE: Dict[str, tuple[float, List[Dict[str, Any]]]] = {}
_JWKS_CACHE_LOCK = threading.Lock()


class AuthenticationError(ValueError):
    """The supplied bearer token is not acceptable."""


class AuthConfigurationError(RuntimeError):
    """The server has not been configured with a usable JWT verifier."""


@dataclass(frozen=True)
class AuthPrincipal:
    """Verified request identity; never contains the raw bearer token."""

    user_id: Optional[str]
    email: Optional[str] = None
    token_id: Optional[str] = None
    authenticated: bool = True


def _decode_segment(segment: str) -> bytes:
    if not segment or not _B64_SEGMENT.fullmatch(segment):
        raise AuthenticationError("Malformed JWT segment.")
    padded = segment + "=" * (-len(segment) % 4)
    try:
        return base64.urlsafe_b64decode(padded.encode("ascii"))
    except (ValueError, binascii.Error) as exc:
        raise AuthenticationError("Malformed JWT encoding.") from exc


def _decode_json_segment(segment: str) -> Dict[str, Any]:
    try:
        raw = _decode_segment(segment).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise AuthenticationError("JWT JSON is not UTF-8.") from exc

    def no_duplicate_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JWT claim")
            result[key] = value
        return result

    try:
        value = json.loads(raw, object_pairs_hook=no_duplicate_keys)
    except (TypeError, ValueError, json.JSONDecodeError, RecursionError) as exc:
        raise AuthenticationError("Malformed JWT JSON.") from exc
    if not isinstance(value, dict):
        raise AuthenticationError("JWT JSON must be an object.")
    return value


# ---------------------------------------------------------------------------
# Minimal RS256/JWKS support (stdlib only)
# ---------------------------------------------------------------------------


def _der_element(data: bytes, offset: int) -> tuple[int, bytes, int]:
    """Read one definite-length DER element, rejecting indefinite encodings."""

    if offset >= len(data):
        raise ValueError("truncated DER element")
    tag = data[offset]
    offset += 1
    if offset >= len(data):
        raise ValueError("truncated DER length")
    first = data[offset]
    offset += 1
    if first & 0x80:
        count = first & 0x7F
        if count == 0 or count > 4 or offset + count > len(data):
            raise ValueError("unsupported DER length")
        length = int.from_bytes(data[offset:offset + count], "big")
        offset += count
    else:
        length = first
    if length < 0 or offset + length > len(data):
        raise ValueError("truncated DER value")
    end = offset + length
    return tag, data[offset:end], end


# OID contents (tag stripped) for rsaEncryption 1.2.840.113549.1.1.1.
_RSA_ENCRYPTION_OID = bytes.fromhex("2a864886f70d010101")


def _rsa_key_from_der(der: bytes) -> tuple[int, int]:
    """Extract an RSA modulus/exponent from a PKCS#1 or SubjectPublicKeyInfo key."""

    tag, sequence, end = _der_element(der, 0)
    if tag != 0x30 or end != len(der):
        raise ValueError("RSA public key must be a DER sequence")
    tag, first, cursor = _der_element(sequence, 0)
    if tag == 0x30:
        # SubjectPublicKeyInfo = SEQUENCE { AlgorithmIdentifier, BIT STRING }.
        # ``first`` is already the complete AlgorithmIdentifier sequence, so
        # validate its OID directly rather than re-reading a nested SEQUENCE.
        oid_tag, oid, oid_end = _der_element(first, 0)
        if oid_tag != 0x06 or not oid.startswith(_RSA_ENCRYPTION_OID):
            raise ValueError("RSA algorithm identifier is invalid")
        if oid_end != len(first):
            # Only an optional explicit NULL parameter is tolerated.
            parameters_tag, parameters, parameters_end = _der_element(first, oid_end)
            if (
                parameters_tag != 0x05
                or parameters != b""
                or parameters_end != len(first)
            ):
                raise ValueError("RSA algorithm parameters are invalid")
        tag, bit_string, cursor = _der_element(sequence, cursor)
        if tag != 0x03 or not bit_string or bit_string[0] != 0 or cursor != len(sequence):
            raise ValueError("RSA public-key bit string is invalid")
        return _rsa_key_from_der(bit_string[1:])
    if tag != 0x02 or not first:
        raise ValueError("RSA modulus is missing")
    modulus = int.from_bytes(first, "big")
    tag, exponent_bytes, cursor = _der_element(sequence, cursor)
    if tag != 0x02 or not exponent_bytes or cursor != len(sequence):
        raise ValueError("RSA exponent is missing")
    exponent = int.from_bytes(exponent_bytes, "big")
    if modulus <= 0 or exponent <= 1 or exponent % 2 == 0:
        raise ValueError("RSA public key values are invalid")
    if modulus.bit_length() < _RSA_MIN_KEY_BITS:
        raise ValueError("RSA public key must be at least 2048 bits")
    return modulus, exponent


def _rsa_key_from_pem(pem: str) -> tuple[int, int]:
    matches = re.findall(
        r"-----BEGIN (?:PUBLIC KEY|RSA PUBLIC KEY)-----\s*(.*?)\s*-----END (?:PUBLIC KEY|RSA PUBLIC KEY)-----",
        pem,
        flags=re.DOTALL,
    )
    if not matches:
        raise ValueError("JWT_PUBLIC_KEY must be a PEM RSA public key")
    encoded = re.sub(r"\s+", "", matches[0])
    try:
        der = base64.b64decode(encoded.encode("ascii"), validate=True)
    except (UnicodeEncodeError, ValueError, binascii.Error) as exc:
        raise ValueError("JWT_PUBLIC_KEY contains invalid base64") from exc
    return _rsa_key_from_der(der)


def _rsa_key_from_jwk(jwk: Mapping[str, Any]) -> tuple[int, int]:
    if jwk.get("kty") != "RSA":
        raise ValueError("JWKS key is not RSA")
    n_value = jwk.get("n")
    e_value = jwk.get("e")
    if not isinstance(n_value, str) or not isinstance(e_value, str):
        raise ValueError("JWKS RSA key is incomplete")
    try:
        modulus = int.from_bytes(_decode_segment(n_value), "big")
        exponent = int.from_bytes(_decode_segment(e_value), "big")
    except (AuthenticationError, ValueError) as exc:
        raise ValueError("JWKS RSA key encoding is invalid") from exc
    if modulus <= 0 or exponent <= 1 or exponent % 2 == 0:
        raise ValueError("JWKS RSA key values are invalid")
    if modulus.bit_length() < _RSA_MIN_KEY_BITS:
        raise ValueError("JWKS RSA key must be at least 2048 bits")
    return modulus, exponent


def _load_jwks(url: str, settings: Settings) -> List[Dict[str, Any]]:
    """Fetch and cache a small, validated JWKS document without redirects."""

    now = time.monotonic()
    with _JWKS_CACHE_LOCK:
        cached = _JWKS_CACHE.get(url)
        if cached is not None and cached[0] > now:
            return cached[1]

    try:
        parsed = urlparse(url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("invalid JWKS URL")
        request = Request(url, headers={"Accept": "application/json"}, method="GET")
        timeout = 5.0
        with _JWKS_OPENER.open(request, timeout=timeout) as response:
            raw = response.read(1_048_577)
        if len(raw) > 1_048_576:
            raise ValueError("JWKS document is too large")
        text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)

        def no_duplicate_keys(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate JWKS member")
                result[key] = value
            return result

        try:
            document = json.loads(text, object_pairs_hook=no_duplicate_keys)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError("JWKS document is not valid JSON") from exc
        keys = document.get("keys") if isinstance(document, dict) else None
        if not isinstance(keys, list) or not keys:
            raise ValueError("JWKS document has no keys")
        normalized: List[Dict[str, Any]] = []
        for key in keys:
            if not isinstance(key, dict):
                raise ValueError("JWKS key is not an object")
            if key.get("kty") == "RSA" and (
                not key.get("alg") or key.get("alg") == "RS256"
            ):
                # Validate now so a malformed key cannot be selected later.
                _rsa_key_from_jwk(key)
                normalized.append(dict(key))
        if not normalized:
            raise ValueError("JWKS has no usable RS256 key")
        with _JWKS_CACHE_LOCK:
            _JWKS_CACHE[url] = (
                now + max(float(settings.jwt_jwks_cache_seconds), 0.0),
                normalized,
            )
        return normalized
    except AuthConfigurationError:
        raise
    except (HTTPError, URLError, OSError, TimeoutError, ValueError, UnicodeError) as exc:
        raise AuthConfigurationError("JWT verification keys are unavailable.") from exc


def _verify_rs256(
    signature: bytes,
    signing_input: bytes,
    header: Mapping[str, Any],
    settings: Settings,
) -> None:
    try:
        if settings.jwt_public_key:
            modulus, exponent = _rsa_key_from_pem(settings.jwt_public_key)
            key_id = str(header.get("kid", ""))
            if settings.jwt_key_id and key_id != settings.jwt_key_id:
                raise AuthenticationError("JWT signing key is not accepted.")
        else:
            keys = _load_jwks(settings.jwt_jwks_url, settings)
            requested_kid = header.get("kid")
            if requested_kid is not None and not isinstance(requested_kid, str):
                raise AuthenticationError("JWT kid is invalid.")
            candidates = [
                key for key in keys
                if requested_kid is None or key.get("kid") == requested_kid
            ]
            if not candidates:
                raise AuthenticationError("JWT signing key is not available.")
            if len(candidates) > 1 and requested_kid is None:
                raise AuthenticationError("JWT signing key is ambiguous.")
            modulus, exponent = _rsa_key_from_jwk(candidates[0])
    except (AuthenticationError, AuthConfigurationError):
        raise
    except ValueError as exc:
        raise AuthConfigurationError("JWT verification key is invalid.") from exc

    modulus_bytes = (modulus.bit_length() + 7) // 8
    if len(signature) != modulus_bytes:
        raise AuthenticationError("JWT signature is invalid.")
    encoded = pow(int.from_bytes(signature, "big"), exponent, modulus)
    try:
        block = encoded.to_bytes(modulus_bytes, "big")
    except OverflowError as exc:
        raise AuthenticationError("JWT signature is invalid.") from exc
    digest_info = _RSA_DIGEST_PREFIX + hashlib.sha256(signing_input).digest()
    padding_length = len(block) - len(digest_info) - 3
    if padding_length < 8:
        raise AuthenticationError("JWT signature is invalid.")
    expected = b"\x00\x01" + (b"\xff" * padding_length) + b"\x00" + digest_info
    if not hmac.compare_digest(expected, block):
        raise AuthenticationError("JWT signature is invalid.")


def _numeric_claim(claims: Mapping[str, Any], name: str) -> Optional[float]:
    if name not in claims:
        return None
    value = claims[name]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AuthenticationError(f"JWT claim {name} must be numeric.")
    try:
        numeric = float(value)
    except (OverflowError, TypeError, ValueError) as exc:
        raise AuthenticationError(f"JWT claim {name} must be finite.") from exc
    if not math.isfinite(numeric):
        raise AuthenticationError(f"JWT claim {name} must be finite.")
    return numeric


def _safe_identity(value: Any, claim_name: str) -> str:
    """Validate an identity as an opaque, exact signed string.

    Do not strip or otherwise normalize the subject: doing so would make
    distinct signed identities alias the same tenant workspace. Optional
    whitespace around a subject is invalid rather than silently discarded.
    """

    if not isinstance(value, str):
        raise AuthenticationError(f"JWT claim {claim_name} must be a string.")
    if not value or len(value) > 255:
        raise AuthenticationError(f"JWT claim {claim_name} is invalid.")
    if value != value.strip():
        raise AuthenticationError(f"JWT claim {claim_name} contains surrounding whitespace.")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise AuthenticationError(f"JWT claim {claim_name} contains control characters.")
    return value


def _validate_standard_claims(
    payload: Mapping[str, Any], settings: Settings, now: Optional[float] = None
) -> None:
    current = time.time() if now is None else now
    skew = float(settings.jwt_clock_skew_seconds)

    expiration = _numeric_claim(payload, "exp")
    if expiration is None:
        raise AuthenticationError("JWT must contain an expiry claim.")
    if current >= expiration + skew:
        raise AuthenticationError("JWT has expired.")

    not_before = _numeric_claim(payload, "nbf")
    if not_before is not None and current + skew < not_before:
        raise AuthenticationError("JWT is not active yet.")

    issued_at = _numeric_claim(payload, "iat")
    if issued_at is not None and current + skew < issued_at:
        raise AuthenticationError("JWT was issued in the future.")

    issuer = settings.jwt_issuer.strip()
    if issuer and payload.get("iss") != issuer:
        raise AuthenticationError("JWT issuer is not accepted.")

    audience = settings.jwt_audience.strip()
    if audience:
        actual = payload.get("aud")
        if isinstance(actual, str):
            actual_audiences = {actual}
        elif isinstance(actual, list) and all(isinstance(item, str) for item in actual):
            actual_audiences = set(actual)
        else:
            raise AuthenticationError("JWT audience is invalid.")
        if audience not in actual_audiences:
            raise AuthenticationError("JWT audience is not accepted.")


def verify_jwt(token: str, settings: Optional[Settings] = None) -> AuthPrincipal:
    """Verify a configured JWT and return its signed tenant identity.

    Only the algorithm configured by the server is accepted; the token's
    ``alg`` header can never select a different verification algorithm.
    """

    if settings is None:
        try:
            settings = Settings()
        except RuntimeError as exc:
            raise AuthConfigurationError(
                "JWT verification is not configured."
            ) from exc
    if settings.auth_mode == "disabled":
        return AuthPrincipal(user_id=None, authenticated=False)
    if settings.auth_mode != "jwt":
        raise AuthConfigurationError("AUTH_MODE is not supported.")
    algorithm = str(getattr(settings, "jwt_algorithm", JWT_ALGORITHM)).upper()
    if algorithm not in SUPPORTED_JWT_ALGORITHMS:
        raise AuthConfigurationError("JWT algorithm is not supported.")
    if algorithm == "HS256":
        secret = settings.jwt_secret
        if not secret or len(secret.encode("utf-8")) < MIN_JWT_SECRET_BYTES:
            raise AuthConfigurationError("JWT verification is not configured.")

    normalized = str(token or "").strip()
    if not normalized or len(normalized) > MAX_TOKEN_LENGTH:
        raise AuthenticationError("JWT is missing or too large.")
    parts = normalized.split(".")
    if len(parts) != 3 or any(not part for part in parts):
        raise AuthenticationError("JWT must have three segments.")

    header = _decode_json_segment(parts[0])
    payload = _decode_json_segment(parts[1])
    if header.get("alg") != algorithm:
        raise AuthenticationError("JWT algorithm is not accepted.")
    if header.get("typ", "JWT") != "JWT":
        raise AuthenticationError("JWT type is not accepted.")
    # Presence, rather than truthiness, matters for crit: even an empty crit
    # list is unsupported by this verifier. b64=false would change the signing
    # input and is likewise never accepted.
    if any(name in header for name in ("crit", "jku", "x5u", "b64")):
        raise AuthenticationError("Unsupported JWT header parameters.")

    signing_input = f"{parts[0]}.{parts[1]}".encode("ascii")
    try:
        supplied_signature = _decode_segment(parts[2])
    except AuthenticationError:
        raise
    if algorithm == "HS256":
        expected = hmac.new(
            secret.encode("utf-8"), signing_input, hashlib.sha256
        ).digest()
        if not hmac.compare_digest(expected, supplied_signature):
            raise AuthenticationError("JWT signature is invalid.")
    else:
        _verify_rs256(supplied_signature, signing_input, header, settings)

    _validate_standard_claims(payload, settings)
    subject = _safe_identity(payload.get("sub"), "sub")
    tenant_claim = settings.jwt_user_id_claim.strip()
    if not _CLAIM_NAME.fullmatch(tenant_claim):
        raise AuthConfigurationError("JWT_USER_ID_CLAIM is invalid.")
    tenant_id = _safe_identity(payload.get(tenant_claim), tenant_claim)
    if tenant_id != subject:
        raise AuthenticationError("JWT subject and tenant identity do not match.")

    email_value = payload.get("email")
    email = None
    if email_value is not None:
        if not isinstance(email_value, str) or len(email_value) > 320:
            raise AuthenticationError("JWT email claim is invalid.")
        email = email_value.strip() or None
    token_id = payload.get("jti")
    if token_id is not None:
        token_id = _safe_identity(token_id, "jti")
    return AuthPrincipal(
        user_id=tenant_id,
        email=email,
        token_id=token_id,
        authenticated=True,
    )


def _settings_or_503() -> Settings:
    try:
        return Settings()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured on the server.",
        ) from exc


def require_auth(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_BEARER),
) -> AuthPrincipal:
    """FastAPI dependency for all V2 routes."""

    settings = _settings_or_503()
    if settings.auth_mode == "disabled":
        # This mode is intentionally explicit and is rejected by Settings when
        # Supabase or production mode is enabled.  It exists only for local
        # development compatibility; public deployments must use JWT mode.
        return AuthPrincipal(user_id=None, authenticated=False)

    if credentials is None or (credentials.scheme or "").lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return verify_jwt(credentials.credentials, settings)
    except AuthConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured on the server.",
        ) from exc
    except AuthenticationError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


def require_v1_auth(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_BEARER),
) -> Optional[AuthPrincipal]:
    """Protect the legacy V1 surface without breaking local demo development.

    V1 operates on a legacy global service and therefore cannot offer the same
    tenant isolation as V2.  It is disabled by default for production and
    Supabase deployments.  If an operator explicitly enables it, this
    dependency still requires a valid JWT; local development may opt out via
    ``V1_REQUIRE_AUTH=false`` for the original mock/demo workflow.
    """

    try:
        settings = Settings()
    except RuntimeError as exc:
        raw_env = os.environ.get("APP_ENV", "development").strip().lower()
        raw_supabase = os.environ.get("USE_SUPABASE", "false").strip().lower()
        raw_v1_auth = os.environ.get("V1_REQUIRE_AUTH", "").strip().lower()
        explicit_v1_auth = raw_v1_auth in {"1", "true", "yes", "on"}
        if (
            explicit_v1_auth
            or raw_env == "production"
            or raw_supabase in {"true", "1", "yes", "on"}
        ):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Authentication is not configured on the server.",
            ) from exc
        # The original local V1 demo is intentionally usable without a server
        # secret. V2 remains fail-closed through require_auth().
        return None

    if not settings.v1_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="The legacy API is disabled for this deployment.",
        )
    if not settings.v1_require_auth:
        return None
    if settings.auth_mode == "disabled":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="V1 authentication is required but AUTH_MODE is disabled.",
        )
    if credentials is None or (credentials.scheme or "").lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return verify_jwt(credentials.credentials, settings)
    except AuthConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured on the server.",
        ) from exc
    except AuthenticationError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


def resolve_tenant_id(
    principal: AuthPrincipal, requested_user_id: Optional[str]
) -> str:
    """Return only the verified tenant, rejecting cross-tenant substitutions."""

    requested = "" if requested_user_id is None else str(requested_user_id)
    if requested_user_id is not None and (not requested or requested != requested.strip()):
        raise HTTPException(status_code=422, detail="user_id is required.")
    if not principal.authenticated:
        if not requested:
            raise HTTPException(status_code=422, detail="user_id is required.")
        return requested
    verified = principal.user_id
    if not isinstance(verified, str) or not verified:
        raise HTTPException(status_code=401, detail="Authentication identity is invalid.")
    if requested and requested != verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated identity does not match the requested tenant.",
        )
    return verified
