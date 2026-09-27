"""Real-crypto regression tests for the ES256 verifier used by Supabase Auth.

Supabase signs access tokens with ES256 (ECDSA P-256 over SHA-256) and publishes
its public key at ``<project>/auth/v1/.well-known/jwks.json`` as a ``kty=EC``
entry. These tests sign real tokens with a real P-256 key rather than stubbing
the signature check, so a regression in the r||s handling or the curve check
fails here.

``cryptography`` is the same package the verifier uses. It is a hard requirement
of ES256, so a test module that cannot import it is skipped rather than failing:
an HS256-only deployment is unaffected by any of this.
"""

from __future__ import annotations

import base64
import json
import secrets
import sys
import time
from urllib.error import HTTPError

import pytest

import backend.auth as backend_auth
from backend.auth import (
    AuthConfigurationError,
    AuthenticationError,
    _ec_key_from_jwk,
    _load_jwks,
    verify_jwt,
)
from backend.config import Settings

cryptography = pytest.importorskip("cryptography", reason="ES256 needs cryptography")

from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import (  # noqa: E402
    decode_dss_signature,
)

from tests.test_auth_rs256 import (  # noqa: E402
    _JwkOpener,
    _MODULUS as _RS_MODULUS,
    _rs256_token,
)


KEY_ID = "supabase-ec-key-1"

# Generated per run: a real P-256 key pair, so nothing about the signature is
# stubbed. Supabase rotates its signing key, and the verifier must not care
# which key in the JWKS is selected.
_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
_PUBLIC_KEY = _PRIVATE_KEY.public_key()
_PUBLIC_NUMBERS = _PUBLIC_KEY.public_numbers()
# A second, unrelated key standing in for an attacker's or a rotated-out key.
_OTHER_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
_OTHER_PUBLIC_NUMBERS = _OTHER_PRIVATE_KEY.public_key().public_numbers()


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _int_to_b64(value: int, width: int | None = None) -> str:
    length = width or ((value.bit_length() + 7) // 8 or 1)
    return _b64(value.to_bytes(length, "big"))


def _coord_b64(value: int, width: int) -> str:
    """Base64url of exactly ``width`` bytes of ``value``, big-endian, zero-padded."""

    return _b64(value.to_bytes(width, "big"))


def _short_b64(raw: bytes) -> str:
    return _b64(raw)


def _jwk(numbers, kid: str = KEY_ID, **overrides) -> dict:
    """Build the ``kty=EC`` JWKS entry shape Supabase serves."""

    entry = {
        "kty": "EC",
        "kid": kid,
        "alg": "ES256",
        "use": "sig",
        "crv": "P-256",
        "x": _int_to_b64(numbers.x, 32),
        "y": _int_to_b64(numbers.y, 32),
    }
    entry.update(overrides)
    return entry


def _es256_token(
    subject: str = "es256-user",
    *,
    key_id: str = KEY_ID,
    algorithm: str = "ES256",
    expires_at: float | None = None,
    private_key=None,
    header_override: dict | None = None,
    claims: dict | None = None,
) -> str:
    """Sign a genuine ES256 token and return it in JOSE compact serialization."""

    now = time.time()
    header_value = {"alg": algorithm, "typ": "JWT", "kid": key_id}
    if header_override is not None:
        header_value = header_override
    payload = {
        "sub": subject,
        "iat": now,
        "exp": now + 600 if expires_at is None else expires_at,
        "aud": "authenticated",
        "role": "authenticated",
    }
    if claims:
        payload.update(claims)

    encoded_header = _b64(json.dumps(header_value, separators=(",", ":")).encode())
    encoded_payload = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")

    der = (private_key or _PRIVATE_KEY).sign(
        signing_input, ec.ECDSA(hashes.SHA256())
    )
    r_value, s_value = decode_dss_signature(der)
    # JOSE is the fixed-width concatenation r||s, not the DER form cryptography
    # produced. Getting this conversion wrong is the easiest way to break
    # verification, so the tests exercise it directly.
    raw = r_value.to_bytes(32, "big") + s_value.to_bytes(32, "big")
    return f"{encoded_header}.{encoded_payload}.{_b64(raw)}"


def _settings(monkeypatch, **overrides) -> Settings:
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    for key in (
        "JWT_SECRET",
        "SUPABASE_JWT_SECRET",
        "JWT_ISSUER",
        "JWT_AUDIENCE",
        "JWT_JWKS_URL",
        "JWT_PUBLIC_KEY",
        "JWT_KEY_ID",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in overrides.items():
        monkeypatch.setenv(key, value)
    return Settings()


def _pem_settings(monkeypatch, **overrides) -> Settings:
    pem = _PUBLIC_KEY.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    return _settings(monkeypatch, JWT_ALGORITHM="ES256", JWT_PUBLIC_KEY=pem, **overrides)


def _jwks_settings(monkeypatch, document, **overrides) -> Settings:
    monkeypatch.setattr("backend.auth._JWKS_CACHE", {})
    monkeypatch.setattr(
        "backend.auth._JWKS_OPENER", _JwkOpener(json.dumps(document).encode("utf-8"))
    )
    return _settings(
        monkeypatch,
        JWT_ALGORITHM="ES256",
        JWT_JWKS_URL="https://project.example/auth/v1/.well-known/jwks.json",
        **overrides,
    )


# --- accepts a genuine signature -------------------------------------------


def test_es256_jwks_accepts_a_genuine_supabase_style_token(monkeypatch):
    """The shape Supabase actually serves: a JWKS with one EC key."""

    settings = _jwks_settings(monkeypatch, {"keys": [_jwk(_PUBLIC_NUMBERS)]})

    principal = verify_jwt(_es256_token(), settings)

    assert principal.user_id == "es256-user"
    assert principal.authenticated is True


def test_es256_pem_public_key_accepts_a_genuine_signature(monkeypatch):
    settings = _pem_settings(monkeypatch, JWT_KEY_ID=KEY_ID)

    assert verify_jwt(_es256_token(), settings).user_id == "es256-user"


def test_es256_subject_binds_the_tenant_like_any_other_algorithm(monkeypatch):
    settings = _jwks_settings(monkeypatch, {"keys": [_jwk(_PUBLIC_NUMBERS)]})
    token = _es256_token("es256-user", claims={"user_id": "someone-else"})

    # The default tenant claim is `sub`; an unrelated extra claim is ignored, so
    # this token is still valid and binds to `sub` only.
    assert verify_jwt(token, settings).user_id == "es256-user"

    monkeypatch.setenv("JWT_USER_ID_CLAIM", "user_id")
    with pytest.raises(AuthenticationError):
        verify_jwt(token, Settings())


# --- rejects everything that is not a valid signature ----------------------


def test_es256_rejects_a_token_signed_by_another_key(monkeypatch):
    settings = _jwks_settings(monkeypatch, {"keys": [_jwk(_PUBLIC_NUMBERS)]})
    token = _es256_token(private_key=_OTHER_PRIVATE_KEY)

    with pytest.raises(AuthenticationError, match="signature is invalid"):
        verify_jwt(token, settings)


def test_es256_rejects_a_tampered_payload(monkeypatch):
    settings = _jwks_settings(monkeypatch, {"keys": [_jwk(_PUBLIC_NUMBERS)]})
    header, _payload, signature = _es256_token().split(".")
    forged = _b64(json.dumps({"sub": "attacker", "exp": time.time() + 600}).encode())

    with pytest.raises(AuthenticationError):
        verify_jwt(f"{header}.{forged}.{signature}", settings)


def test_es256_rejects_an_expired_token(monkeypatch):
    settings = _jwks_settings(monkeypatch, {"keys": [_jwk(_PUBLIC_NUMBERS)]})

    with pytest.raises(AuthenticationError):
        verify_jwt(_es256_token(expires_at=time.time() - 5), settings)


def test_es256_rejects_a_foreign_or_missing_key_id(monkeypatch):
    document = {
        "keys": [
            _jwk(_PUBLIC_NUMBERS, kid="key-a"),
            _jwk(_OTHER_PUBLIC_NUMBERS, kid="key-b"),
        ]
    }

    settings = _jwks_settings(monkeypatch, document)
    assert verify_jwt(_es256_token(key_id="key-b", private_key=_OTHER_PRIVATE_KEY),
                      settings).user_id == "es256-user"

    with pytest.raises(AuthenticationError, match="not available"):
        verify_jwt(_es256_token(key_id="key-c"), settings)

    # With a pinned key id, a different key in the document is still refused.
    settings = _jwks_settings(monkeypatch, document, JWT_KEY_ID="key-a")
    with pytest.raises(AuthenticationError, match="not accepted"):
        verify_jwt(_es256_token(key_id="key-b", private_key=_OTHER_PRIVATE_KEY),
                   settings)


def test_es256_rejects_an_ambiguous_key_set(monkeypatch):
    """No ``kid`` in the header plus two usable keys must be refused, not guessed."""

    document = {
        "keys": [
            _jwk(_PUBLIC_NUMBERS, kid="key-a"),
            _jwk(_OTHER_PUBLIC_NUMBERS, kid="key-b"),
        ]
    }
    settings = _jwks_settings(monkeypatch, document)
    header, payload, signature = _es256_token().split(".")
    decoded = json.loads(base64.urlsafe_b64decode(header + "=" * (-len(header) % 4)))
    decoded.pop("kid")
    bare = _b64(json.dumps(decoded, separators=(",", ":")).encode())

    with pytest.raises(AuthenticationError, match="ambiguous"):
        verify_jwt(f"{bare}.{payload}.{signature}", settings)


def test_es256_rejects_a_malformed_signature_length(monkeypatch):
    """A DER signature, or a truncated one, is not a JOSE ES256 signature."""

    settings = _jwks_settings(monkeypatch, {"keys": [_jwk(_PUBLIC_NUMBERS)]})
    header, payload, _signature = _es256_token().split(".")
    signing_input = f"{header}.{payload}".encode("ascii")
    der = _PRIVATE_KEY.sign(signing_input, ec.ECDSA(hashes.SHA256()))

    # DER, which is what cryptography produces and what JOSE does not use.
    with pytest.raises(AuthenticationError, match="signature is invalid"):
        verify_jwt(f"{header}.{payload}.{_b64(der)}", settings)
    # Truncated r||s.
    with pytest.raises(AuthenticationError, match="signature is invalid"):
        verify_jwt(f"{header}.{payload}.{_b64(b'\\x01' * 63)}", settings)
    # One byte too long.
    with pytest.raises(AuthenticationError, match="signature is invalid"):
        verify_jwt(f"{header}.{payload}.{_b64(b'\\x01' * 65)}", settings)


def test_es256_rejects_an_all_zero_signature(monkeypatch):
    settings = _jwks_settings(monkeypatch, {"keys": [_jwk(_PUBLIC_NUMBERS)]})
    header, payload, _signature = _es256_token().split(".")

    with pytest.raises(AuthenticationError, match="signature is invalid"):
        verify_jwt(f"{header}.{payload}.{_b64(bytes(64))}", settings)


def test_es256_cannot_be_downgraded_to_another_algorithm(monkeypatch):
    """The header still cannot choose the verifier, in either direction."""

    settings = _jwks_settings(monkeypatch, {"keys": [_jwk(_PUBLIC_NUMBERS)]})

    with pytest.raises(AuthenticationError, match="algorithm is not accepted"):
        verify_jwt(_es256_token(header_override={"alg": "RS256", "typ": "JWT",
                                                "kid": KEY_ID}), settings)
    with pytest.raises(AuthenticationError, match="algorithm is not accepted"):
        verify_jwt(_es256_token(header_override={"alg": "none", "typ": "JWT"}),
                   settings)

    # And a server configured for ES256 must reject an HS256 token, which is
    # the algorithm-confusion case: a caller who knows any shared secret.
    import base64 as _b64mod
    import hashlib
    import hmac

    header = _b64mod.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode()
    ).rstrip(b"=").decode("ascii")
    payload = _b64mod.urlsafe_b64encode(
        json.dumps({"sub": "es256-user", "exp": time.time() + 600},
                   separators=(",", ":")).encode()
    ).rstrip(b"=").decode("ascii")
    signing_input = f"{header}.{payload}".encode("ascii")
    mac = hmac.new(b"attacker-known-secret", signing_input, hashlib.sha256).digest()
    with pytest.raises(AuthenticationError, match="algorithm is not accepted"):
        verify_jwt(f"{header}.{payload}.{_b64(mac)}", settings)


# --- key handling ----------------------------------------------------------


def test_ec_key_requires_the_p256_curve(monkeypatch):
    """ES256 is only defined over P-256, so another EC curve is refused."""

    settings = _jwks_settings(
        monkeypatch, {"keys": [_jwk(_PUBLIC_NUMBERS, crv="P-384")]}
    )
    with pytest.raises(AuthConfigurationError):
        verify_jwt(_es256_token(), settings)


def test_ec_key_requires_full_length_coordinates(monkeypatch):
    """A short or over-long coordinate is not a canonical P-256 point."""

    short = _jwk(_PUBLIC_NUMBERS)
    # 31 bytes instead of the required 32: a coordinate that would need padding
    # to be interpreted, which RFC 7518 does not allow.
    short["x"] = _b64(_PUBLIC_NUMBERS.x.to_bytes(32, "big")[:-1])
    settings = _jwks_settings(monkeypatch, {"keys": [short]})
    with pytest.raises(AuthConfigurationError):
        verify_jwt(_es256_token(), settings)

    over_long = _jwk(_PUBLIC_NUMBERS)
    over_long["y"] = _b64(_PUBLIC_NUMBERS.y.to_bytes(33, "big"))
    settings = _jwks_settings(monkeypatch, {"keys": [over_long]})
    with pytest.raises(AuthConfigurationError):
        verify_jwt(_es256_token(), settings)


def test_ec_key_must_be_a_point_on_the_curve(monkeypatch):
    """Coordinates that are not on P-256 must not become a usable key."""

    off_curve = _jwk(_PUBLIC_NUMBERS, y=_int_to_b64(_PUBLIC_NUMBERS.y ^ 1, 32))
    with pytest.raises(ValueError, match="curve point"):
        _ec_key_from_jwk(off_curve)


def test_ec_key_rejects_a_non_ec_pem(monkeypatch):
    """An RSA public key configured for ES256 is a configuration error."""

    from tests.test_auth_rs256 import _PUBLIC_KEY_PEM

    settings = _settings(
        monkeypatch, JWT_ALGORITHM="ES256", JWT_PUBLIC_KEY=_PUBLIC_KEY_PEM
    )
    with pytest.raises(AuthConfigurationError):
        verify_jwt(_es256_token(), settings)


def test_ec_key_rejects_a_malformed_pem(monkeypatch):
    settings = _settings(
        monkeypatch, JWT_ALGORITHM="ES256", JWT_PUBLIC_KEY="not a pem at all"
    )
    with pytest.raises(AuthConfigurationError):
        verify_jwt(_es256_token(), settings)


# --- JWKS selection and caching -------------------------------------------


def test_jwks_ignores_keys_of_other_types(monkeypatch):
    """An RSA entry in the same document must not be selectable for ES256."""

    document = {
        "keys": [
            {"kty": "RSA", "kid": KEY_ID, "n": _int_to_b64(65537), "e": "AQAB"},
            {"kty": "oct", "kid": KEY_ID, "k": "c2hvdWxkLW5ldC1hcHBlYXI"},
            _jwk(_PUBLIC_NUMBERS),
        ]
    }
    settings = _jwks_settings(monkeypatch, document)

    assert verify_jwt(_es256_token(), settings).user_id == "es256-user"


def test_jwks_with_no_usable_ec_key_is_a_configuration_error(monkeypatch):
    document = {
        "keys": [
            {"kty": "RSA", "kid": KEY_ID, "n": _int_to_b64(65537), "e": "AQAB"},
            _jwk(_PUBLIC_NUMBERS, alg="ES384"),
        ]
    }
    settings = _jwks_settings(monkeypatch, document)

    with pytest.raises(AuthConfigurationError):
        verify_jwt(_es256_token(), settings)


def test_jwks_cache_is_keyed_by_algorithm_not_just_url(monkeypatch):
    """One URL can serve both key types; the filtered cache must not mix them.

    A cache keyed by URL alone would let an RS256 verification populate the
    entry with RSA keys, and a later ES256 verification at the same URL would
    be handed a list containing no EC key at all -- a failure that presents as a
    missing key rather than as a cache bug.
    """

    document = {
        "keys": [
            {
                "kty": "RSA",
                "kid": "test-key-1",
                "alg": "RS256",
                "n": _b64(_RS_MODULUS.to_bytes((_RS_MODULUS.bit_length() + 7) // 8,
                                              "big")),
                "e": _b64((65537).to_bytes(3, "big")),
            },
            _jwk(_PUBLIC_NUMBERS),
        ]
    }
    monkeypatch.setattr("backend.auth._JWKS_CACHE", {})
    monkeypatch.setattr(
        "backend.auth._JWKS_OPENER", _JwkOpener(json.dumps(document).encode("utf-8"))
    )
    url = "https://shared.example/.well-known/jwks.json"

    # Prime the cache with the RS256 view of the same URL.
    rs256 = _settings(monkeypatch, JWT_ALGORITHM="RS256", JWT_JWKS_URL=url)
    assert verify_jwt(_rs256_token(), rs256).user_id == "rs256-user"

    es256 = _settings(monkeypatch, JWT_ALGORITHM="ES256", JWT_JWKS_URL=url)
    # Would raise "no usable ES256 key" if the RS256-filtered list were reused.
    assert verify_jwt(_es256_token(), es256).user_id == "es256-user"


def test_jwks_cache_serves_a_second_verification_without_a_fetch(monkeypatch):
    opener = _JwkOpener(
        json.dumps({"keys": [_jwk(_PUBLIC_NUMBERS)]}).encode("utf-8")
    )
    monkeypatch.setattr("backend.auth._JWKS_CACHE", {})
    monkeypatch.setattr("backend.auth._JWKS_OPENER", opener)
    settings = _settings(
        monkeypatch,
        JWT_ALGORITHM="ES256",
        JWT_JWKS_URL="https://project.example/auth/v1/.well-known/jwks.json",
    )

    verify_jwt(_es256_token(), settings)
    verify_jwt(_es256_token(subject="es256-user-2"), settings)

    assert opener.calls == 1


def test_es256_jwks_url_must_be_a_plain_https_url(monkeypatch):
    for url in (
        "ftp://project.example/jwks.json",
        "https://user:pass@project.example/jwks.json",
        "https://project.example/jwks.json?next=1",
    ):
        with pytest.raises(RuntimeError):
            _settings(monkeypatch, JWT_ALGORITHM="ES256", JWT_JWKS_URL=url)
    with pytest.raises(RuntimeError, match="HTTPS"):
        _settings(
            monkeypatch,
            APP_ENV="production",
            JWT_ALGORITHM="ES256",
            JWT_JWKS_URL="http://project.example/jwks.json",
        )


def test_es256_jwks_fetch_refuses_redirects(monkeypatch):
    class _RedirectingOpener:
        def __init__(self):
            self.calls = 0

        def open(self, request, timeout=None):
            self.calls += 1
            raise HTTPError(request.full_url, 302, "Found", {}, None)

    opener = _RedirectingOpener()
    monkeypatch.setattr("backend.auth._JWKS_CACHE", {})
    monkeypatch.setattr("backend.auth._JWKS_OPENER", opener)
    settings = _settings(
        monkeypatch,
        JWT_ALGORITHM="ES256",
        JWT_JWKS_URL="https://project.example/jwks.json",
    )

    with pytest.raises(AuthConfigurationError):
        _load_jwks(settings.jwt_jwks_url, settings, "ES256")
    assert opener.calls == 1


# --- configuration boundaries ----------------------------------------------


def test_missing_es256_key_material_fails_closed(monkeypatch):
    with pytest.raises(RuntimeError, match="JWT_PUBLIC_KEY or JWT_JWKS_URL"):
        _settings(monkeypatch, JWT_ALGORITHM="ES256")


def test_es256_reports_missing_cryptography_as_configuration(monkeypatch):
    """Without the package the server must refuse, never accept unverified.

    A ``sys.modules`` entry of ``None`` makes any import of that name raise
    ``ImportError``, which is the condition being simulated here. The
    module-level cache is process-wide, so it is saved and restored around the
    test rather than left cleared for whatever runs next.
    """

    settings = _jwks_settings(monkeypatch, {"keys": [_jwk(_PUBLIC_NUMBERS)]})
    saved = backend_auth._ECDSA_MODULES
    monkeypatch.setattr(backend_auth, "_ECDSA_MODULES", None)
    monkeypatch.setitem(sys.modules, "cryptography", None)
    monkeypatch.setitem(sys.modules, "cryptography.exceptions", None)
    try:
        with pytest.raises(AuthConfigurationError, match="cryptography"):
            verify_jwt(_es256_token(), settings)
    finally:
        monkeypatch.setattr(backend_auth, "_ECDSA_MODULES", saved)


def test_unknown_algorithm_is_rejected_by_configuration(monkeypatch):
    with pytest.raises(RuntimeError, match="HS256, RS256 or ES256"):
        _settings(monkeypatch, JWT_ALGORITHM="ES512")


def test_es256_is_not_accepted_by_an_hs256_server(monkeypatch):
    """A token signed for the new deployment must not open the old one."""

    settings = _settings(
        monkeypatch, JWT_ALGORITHM="HS256", JWT_SECRET="test-" + secrets.token_urlsafe(48)
    )
    with pytest.raises(AuthenticationError, match="algorithm is not accepted"):
        verify_jwt(_es256_token(), settings)
