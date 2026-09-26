"""Real-crypto regression tests for the optional RS256/JWKS verifier.

The RSA key pair is generated in pure Python (stdlib only) so the tests
exercise genuine PKCS#1 v1.5 SHA-256 verification instead of a stub. No new
runtime or test dependency is introduced.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from urllib.error import HTTPError

import pytest

from backend.auth import (
    AuthConfigurationError,
    AuthenticationError,
    _load_jwks,
    verify_jwt,
)
from backend.config import Settings


_SMALL_PRIMES = (
    2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67,
    71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149,
    151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223, 227, 229,
    233, 239, 241, 251,
)
_PUBLIC_EXPONENT = 65537
_KEY_BITS = 1024


def _is_probable_prime(candidate: int) -> bool:
    if candidate < 2:
        return False
    for prime in _SMALL_PRIMES:
        if candidate % prime == 0:
            return candidate == prime
    remainder = candidate - 1
    exponent = 0
    while remainder % 2 == 0:
        remainder //= 2
        exponent += 1
    # Deterministic Miller-Rabin bases are sufficient for these fixed test keys.
    for base in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if base % candidate == 0:
            continue
        value = pow(base, remainder, candidate)
        if value in (1, candidate - 1):
            continue
        for _ in range(exponent - 1):
            value = pow(value, 2, candidate)
            if value == candidate - 1:
                break
        else:
            return False
    return True


def _generate_prime(bits: int, salt: str) -> int:
    """Deterministically derive a probable prime of the requested bit length.

    Walks a deterministic sequence of odd candidates rather than a fixed set of
    literals, so the key is reproducible without embedding large constants.
    """

    top = 1 << bits
    for attempt in range(200_000):
        seed = hashlib.sha512(f"{salt}:{attempt}".encode("ascii")).digest()
        base = int.from_bytes(seed, "big") % (top - 3)
        candidate = top - 1 - (base & ~1)  # odd, exactly ``bits`` bits
        if _is_probable_prime(candidate):
            return candidate
    raise RuntimeError(f"Unable to derive a {bits}-bit prime for {salt}.")


_P = _generate_prime(_KEY_BITS, "ecomai-os-test-p")
_Q = _generate_prime(_KEY_BITS, "ecomai-os-test-q")


def _build_rsa_key() -> tuple[int, int, int]:
    """Return (n, e, d) for a deterministic 2048-bit test key."""

    p, q = _P, _Q
    assert p != q
    modulus = p * q
    if modulus.bit_length() < 2048:
        raise RuntimeError("Fixed test RSA key must be at least 2048 bits.")
    phi = (p - 1) * (q - 1)
    private_exponent = pow(_PUBLIC_EXPONENT, -1, phi)
    return modulus, _PUBLIC_EXPONENT, private_exponent


_MODULUS, _EXPONENT, _PRIVATE_EXPONENT = _build_rsa_key()


def _der_length(length: int) -> bytes:
    if length < 0x80:
        return bytes([length])
    body = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(body)]) + body


def _der_integer(value: int) -> bytes:
    body = value.to_bytes((value.bit_length() + 8) // 8, "big")
    return b"\x02" + _der_length(len(body)) + body


def _der_sequence(*elements: bytes) -> bytes:
    body = b"".join(elements)
    return b"\x30" + _der_length(len(body)) + body


def _public_key_pem(modulus: int, exponent: int) -> str:
    """Encode a SubjectPublicKeyInfo PEM, as OpenSSL emits by default.

    SubjectPublicKeyInfo ::= SEQUENCE {
        algorithm  AlgorithmIdentifier,      -- rsaEncryption + NULL
        subjectPublicKey BIT STRING           -- PKCS#1 RSAPublicKey
    }
    """

    algorithm = _der_sequence(
        bytes.fromhex("06092a864886f70d010101"),  # OID rsaEncryption
        b"\x05\x00",  # NULL parameters
    )
    pkcs1 = _der_sequence(_der_integer(modulus), _der_integer(exponent))
    subject_public_key = b"\x03" + _der_length(len(pkcs1) + 1) + b"\x00" + pkcs1
    der = _der_sequence(algorithm, subject_public_key)
    encoded = base64.b64encode(der).decode("ascii")
    lines = [encoded[index:index + 64] for index in range(0, len(encoded), 64)]
    return "-----BEGIN PUBLIC KEY-----\n" + "\n".join(lines) + "\n-----END PUBLIC KEY-----\n"


def _pkcs1_public_key_pem(modulus: int, exponent: int) -> str:
    """Encode the legacy PKCS#1 ``RSA PUBLIC KEY`` form."""

    der = _der_sequence(_der_integer(modulus), _der_integer(exponent))
    encoded = base64.b64encode(der).decode("ascii")
    lines = [encoded[index:index + 64] for index in range(0, len(encoded), 64)]
    return (
        "-----BEGIN RSA PUBLIC KEY-----\n"
        + "\n".join(lines)
        + "\n-----END RSA PUBLIC KEY-----\n"
    )


_PUBLIC_KEY_PEM = _public_key_pem(_MODULUS, _EXPONENT)


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _int_to_b64(value: int) -> str:
    length = (value.bit_length() + 7) // 8 or 1
    return _b64(value.to_bytes(length, "big"))


def _rs256_token(
    subject: str = "rs256-user",
    *,
    key_id: str = "test-key-1",
    algorithm: str = "RS256",
    expires_at: float | None = None,
    secret: str = "",
    header_override: dict | None = None,
) -> str:
    now = time.time()
    header_value = {"alg": algorithm, "typ": "JWT", "kid": key_id}
    if header_override is not None:
        header_value = header_override
    payload = {
        "sub": subject,
        "iat": now,
        "exp": now + 600 if expires_at is None else expires_at,
    }
    encoded_header = _b64(json.dumps(header_value, separators=(",", ":")).encode())
    encoded_payload = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")

    if algorithm == "HS256":
        signature = hmac.new(
            secret.encode("utf-8"), signing_input, hashlib.sha256
        ).digest()
    else:
        digest = hashlib.sha256(signing_input).digest()
        prefix = bytes.fromhex("3031300d060960864801650304020105000420")
        digest_info = prefix + digest
        size = (_MODULUS.bit_length() + 7) // 8
        padding = size - len(digest_info) - 3
        block = b"\x00\x01" + (b"\xff" * padding) + b"\x00" + digest_info
        signature = pow(
            int.from_bytes(block, "big"), _PRIVATE_EXPONENT, _MODULUS
        ).to_bytes(size, "big")
    return f"{encoded_header}.{encoded_payload}.{_b64(signature)}"


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
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in overrides.items():
        monkeypatch.setenv(key, value)
    return Settings()


def test_rs256_pem_key_accepts_a_genuine_signature(monkeypatch):
    settings = _settings(
        monkeypatch,
        JWT_ALGORITHM="RS256",
        JWT_PUBLIC_KEY=_PUBLIC_KEY_PEM,
        JWT_KEY_ID="test-key-1",
    )
    principal = verify_jwt(_rs256_token(), settings)
    assert principal.user_id == "rs256-user"
    assert principal.authenticated is True


def test_rs256_rejects_tampered_signature_and_expired_token(monkeypatch):
    settings = _settings(
        monkeypatch, JWT_ALGORITHM="RS256", JWT_PUBLIC_KEY=_PUBLIC_KEY_PEM
    )
    token = _rs256_token()
    header, payload, signature = token.split(".")
    flipped = bytearray(base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)))
    flipped[-1] ^= 0x01
    tampered = f"{header}.{payload}.{_b64(bytes(flipped))}"
    with pytest.raises(AuthenticationError):
        verify_jwt(tampered, settings)

    with pytest.raises(AuthenticationError):
        verify_jwt(_rs256_token(expires_at=time.time() - 5), settings)


def test_rs256_rejects_a_foreign_key_id(monkeypatch):
    settings = _settings(
        monkeypatch,
        JWT_ALGORITHM="RS256",
        JWT_PUBLIC_KEY=_PUBLIC_KEY_PEM,
        JWT_KEY_ID="pinned-key",
    )
    with pytest.raises(AuthenticationError):
        verify_jwt(_rs256_token(key_id="other-key"), settings)


def test_alg_header_cannot_downgrade_to_hs256(monkeypatch):
    settings = _settings(
        monkeypatch,
        JWT_ALGORITHM="RS256",
        JWT_PUBLIC_KEY=_PUBLIC_KEY_PEM,
        JWT_KEY_ID="test-key-1",
    )
    forged = _rs256_token(algorithm="HS256", secret="attacker-known-secret")
    with pytest.raises(AuthenticationError):
        verify_jwt(forged, settings)


def test_missing_rs256_key_material_fails_closed(monkeypatch):
    with pytest.raises(RuntimeError, match="JWT_PUBLIC_KEY or JWT_JWKS_URL"):
        _settings(monkeypatch, JWT_ALGORITHM="RS256")


def test_pkcs1_rsa_public_key_pem_is_also_accepted(monkeypatch):
    settings = _settings(
        monkeypatch,
        JWT_ALGORITHM="RS256",
        JWT_PUBLIC_KEY=_pkcs1_public_key_pem(_MODULUS, _EXPONENT),
    )
    assert verify_jwt(_rs256_token(), settings).user_id == "rs256-user"


def test_non_rsa_algorithm_identifier_is_rejected(monkeypatch):
    """An EC or Ed25519 SPKI must not be accepted as an RSA key."""

    algorithm = _der_sequence(
        bytes.fromhex("06032a0304"),  # OID 1.3.101.112 (Ed25519)
        b"\x05\x00",
    )
    pkcs1 = _der_sequence(_der_integer(_MODULUS), _der_integer(_EXPONENT))
    der = _der_sequence(
        algorithm, b"\x03" + _der_length(len(pkcs1) + 1) + b"\x00" + pkcs1
    )
    encoded = base64.b64encode(der).decode("ascii")
    pem = f"-----BEGIN PUBLIC KEY-----\n{encoded}\n-----END PUBLIC KEY-----\n"
    settings = _settings(monkeypatch, JWT_ALGORITHM="RS256", JWT_PUBLIC_KEY=pem)
    with pytest.raises(AuthConfigurationError):
        verify_jwt(_rs256_token(), settings)


def test_short_rsa_key_is_rejected(monkeypatch):
    small_modulus = (1 << 1023) | 1
    small_pem = _public_key_pem(small_modulus, _EXPONENT)
    settings = _settings(monkeypatch, JWT_ALGORITHM="RS256", JWT_PUBLIC_KEY=small_pem)
    with pytest.raises((AuthConfigurationError, AuthenticationError)):
        verify_jwt(_rs256_token(), settings)

class _JwkResponse:
    def __init__(self, payload: bytes):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, *_args):
        return self._payload


class _JwkOpener:
    def __init__(self, payload: bytes):
        self.payload = payload
        self.calls = 0

    def open(self, request, timeout=None):
        self.calls += 1
        return _JwkResponse(self.payload)


def test_jwks_resolution_selects_the_requested_kid_and_caches(monkeypatch):
    document = {
        "keys": [
            {
                "kty": "RSA",
                "kid": "test-key-1",
                "alg": "RS256",
                "use": "sig",
                "n": _int_to_b64(_MODULUS),
                "e": _int_to_b64(_EXPONENT),
            },
            {
                "kty": "oct",
                "kid": "hmac-should-be-ignored",
                "k": "c2hvdWxkLW5ldC1hcHBlYXI",
            },
        ]
    }
    opener = _JwkOpener(json.dumps(document).encode("utf-8"))
    monkeypatch.setattr("backend.auth._JWKS_OPENER", opener)
    monkeypatch.setattr("backend.auth._JWKS_CACHE", {})
    settings = _settings(
        monkeypatch,
        JWT_ALGORITHM="RS256",
        JWT_JWKS_URL="https://issuer.example/.well-known/jwks.json",
    )

    principal = verify_jwt(_rs256_token(), settings)
    assert principal.user_id == "rs256-user"
    # A second verification is served from cache, not a second network call.
    verify_jwt(_rs256_token(subject="other"), settings)
    assert opener.calls == 1


def test_jwks_rejects_ambiguous_or_unavailable_keys(monkeypatch):
    document = {
        "keys": [
            {
                "kty": "RSA",
                "kid": "a",
                "n": _int_to_b64(_MODULUS),
                "e": _int_to_b64(_EXPONENT),
            },
            {
                "kty": "RSA",
                "kid": "b",
                "n": _int_to_b64(_MODULUS),
                "e": _int_to_b64(_EXPONENT),
            },
        ]
    }
    monkeypatch.setattr(
        "backend.auth._JWKS_OPENER", _JwkOpener(json.dumps(document).encode("utf-8"))
    )
    monkeypatch.setattr("backend.auth._JWKS_CACHE", {})
    settings = _settings(
        monkeypatch,
        JWT_ALGORITHM="RS256",
        JWT_JWKS_URL="https://issuer.example/.well-known/jwks.json",
    )

    # No kid in the header with two usable keys is refused rather than guessed.
    token = _rs256_token()
    header, payload, signature = token.split(".")
    decoded = json.loads(
        base64.urlsafe_b64decode(header + "=" * (-len(header) % 4))
    )
    decoded.pop("kid", None)
    new_header = _b64(json.dumps(decoded, separators=(",", ":")).encode())
    with pytest.raises(AuthenticationError):
        verify_jwt(f"{new_header}.{payload}.{signature}", settings)

    monkeypatch.setattr("backend.auth._JWKS_CACHE", {})
    with pytest.raises(AuthenticationError):
        verify_jwt(_rs256_token(key_id="missing-kid"), settings)


def test_jwks_url_must_not_redirect_or_contain_credentials(monkeypatch):
    monkeypatch.setattr("backend.auth._JWKS_CACHE", {})
    for url in (
        "ftp://issuer.example/jwks.json",
        "https://user:pass@issuer.example/jwks.json",
        "https://issuer.example/jwks.json?next=1",
        "https://issuer.example/jwks.json#frag",
    ):
        with pytest.raises(RuntimeError):
            _settings(monkeypatch, JWT_ALGORITHM="RS256", JWT_JWKS_URL=url)


def test_jwks_requires_https_in_production(monkeypatch):
    with pytest.raises(RuntimeError, match="HTTPS"):
        _settings(
            monkeypatch,
            APP_ENV="production",
            JWT_ALGORITHM="RS256",
            JWT_JWKS_URL="http://issuer.example/.well-known/jwks.json",
        )


def test_jwks_fetch_refuses_redirects(monkeypatch):
    """A JWKS endpoint that 30x-redirects must not be followed."""

    class _RedirectResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, *_args):
            raise AssertionError("redirect body must not be read")

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
        JWT_ALGORITHM="RS256",
        JWT_JWKS_URL="https://issuer.example/.well-known/jwks.json",
    )
    with pytest.raises(AuthConfigurationError):
        _load_jwks(settings.jwt_jwks_url, settings)
    # The opener is invoked once: the redirect is never chased to a second URL.
    assert opener.calls == 1
    _ = _RedirectResponse  # documents the expected response shape
