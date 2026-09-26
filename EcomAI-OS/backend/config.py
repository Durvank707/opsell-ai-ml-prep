"""Environment-driven configuration for EcomAI-OS.

Production rules enforced here:

1.  Secrets are NEVER hardcoded in source. They come exclusively from the
    environment (real deploy) or a local ``.env`` file (development), which is
    git-ignored. Only non-secret placeholders live in ``.env.example``.
2.  The service-role/secret key must never be exposed to the browser. The
    frontend only ever sees the publishable key, and even that only exists in
    a browser-reachable context when a real Supabase project is configured.
3.  ``USE_SUPABASE`` gates whether the persistence layer is the in-process
    isolated store (verifiable right now, no external services) or a live
    Supabase project configured through environment variables.
4.  Fail fast with a clear message rather than silently running degraded when
    a required secret/flag is misconfigured.

Nothing in this module performs I/O against Supabase; it only reads config.
"""

from __future__ import annotations

import math
import os
import re
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# .env loading (stdlib only — no python-dotenv dependency)
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[1]

# Canonical raw store — additive, byte-verified on disk (data/raw/sales.csv).
RAW_SALES_CSV = REPO_ROOT / "data" / "raw" / "sales.csv"

# Search order: explicit ECOMAI_OS_ENV_FILE -> backend/.env -> repo root .env.
def _candidate_env_files() -> list[str]:
    explicit = os.environ.get("ECOMAI_OS_ENV_FILE", "").strip()
    if explicit:
        # An explicit path is authoritative: it is the only file considered.
        # This lets a caller (for example the test suite) opt out of `.env`
        # discovery entirely instead of inheriting ambient credentials.
        return [explicit]
    return [
        str(Path(__file__).resolve().parent / ".env"),
        str(REPO_ROOT / ".env"),
    ]


def _load_dotenv_files() -> None:
    """Best-effort load of local .env files (only overrides unset vars)."""
    for env_file in _candidate_env_files():
        if not env_file:
            continue
        path = Path(env_file)
        if not path.is_file():
            continue
        try:
            for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
        except OSError:
            # .env is a convenience; if unreadable, fall through to env vars.
            continue


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

_PLACEHOLDER_PATTERN = re.compile(
    r"^(your-|<your-|your_|your-+|\.{3}|xxx|placeholder|changeme|example)\.?",
    re.IGNORECASE,
)


def _looks_like_placeholder(value: str) -> bool:
    trimmed = value.strip()
    if not trimmed:
        return True
    # Placeholder markers the .env.example file uses.
    if re.fullmatch(r"^<[^<>]+>$", trimmed):
        return True
    if _PLACEHOLDER_PATTERN.match(trimmed):
        return True
    lowered = trimmed.casefold()
    if any(marker in lowered for marker in (
        "placeholder", "your-project", "your_project", "example.supabase",
        "changeme", "replace-me",
    )):
        return True
    return False


def _is_valid_supabase_url(value: str) -> bool:
    """Accept a plain HTTP(S) project base URL, not a credential-bearing URL."""

    if not value or any(character.isspace() for character in value):
        return False
    try:
        parsed = urlparse(value)
        # Accessing hostname/port also validates malformed brackets and ports.
        hostname = parsed.hostname
        parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme in {"http", "https"}
        and bool(hostname)
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment
    )


def _positive_env_int(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.environ.get(name, str(default)).strip()
    try:
        return max(minimum, int(raw))
    except (TypeError, ValueError):
        return default


def _bounded_env_float(
    name: str,
    default: float,
    *,
    minimum: float,
    maximum: float,
) -> float:
    """Read a finite, bounded numeric setting without failing app startup."""

    raw = os.environ.get(name, str(default)).strip()
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if value != value:  # NaN
        return default
    return min(max(value, minimum), maximum)


def _strict_bounded_env_int(
    name: str,
    default: int,
    *,
    minimum: int,
    maximum: int,
) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"{name} must be an integer.") from exc
    if value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}.")
    return value


def _strict_bounded_env_float(
    name: str,
    default: float,
    *,
    minimum: float,
    maximum: float,
) -> float:
    """Read a security-sensitive numeric setting and fail closed on typos."""

    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw.strip())
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"{name} must be a finite number.") from exc
    if not math.isfinite(value) or value < minimum or value > maximum:
        raise RuntimeError(
            f"{name} must be a finite number between {minimum} and {maximum}."
        )
    return value


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


class Settings:
    """Typed, env-backed configuration."""

    def __init__(self) -> None:
        _load_dotenv_files()

        # -- Supabase integration gate -------------------------------------
        # "true"/"1"/"yes" -> use Supabase-backed services.
        raw_flag = os.environ.get("USE_SUPABASE", "false").strip().lower()
        if raw_flag not in {"", "true", "false", "1", "0", "yes", "no", "on", "off"}:
            raise RuntimeError(
                "USE_SUPABASE must be one of true/false, 1/0, yes/no, or on/off."
            )
        self.use_supabase = raw_flag in {"true", "1", "yes", "on"}

        self.supabase_url = os.environ.get("SUPABASE_URL", "").strip()
        # publishable key is the ONLY key the browser/service may reference.
        self.supabase_publishable_key = (
            os.environ.get("SUPABASE_PUBLISHABLE_KEY")
            or os.environ.get("SUPABASE_ANON_KEY", "")
        ).strip()
        # service-role/secret key: server-side ONLY. Never forwarded to the
        # frontend, never logged, never serialized into any response schema.
        self.supabase_service_role_key = os.environ.get(
            "SUPABASE_SERVICE_ROLE_KEY", ""
        ).strip()

        # -- Application behavior ------------------------------------------
        # When USE_SUPABASE is off we run the fully-local, in-process,
        # per-user isolated store (the same store the tests exercise). The
        # demo tenant carries the canonical seeded workspace.
        self.local_store = not self.use_supabase

        # -- V2 authentication ---------------------------------------------
        # V2 is fail-closed by default: a caller-provided user_id is never an
        # identity.  ``disabled`` is an explicit local-development escape
        # hatch and is rejected when Supabase or production mode is enabled.
        self.app_env = os.environ.get("APP_ENV", "development").strip().lower()
        if self.app_env not in {"development", "test", "production"}:
            raise RuntimeError("APP_ENV must be development, test, or production.")

        raw_auth_mode = os.environ.get("AUTH_MODE", "jwt").strip().lower()
        if raw_auth_mode not in {"jwt", "disabled"}:
            raise RuntimeError("AUTH_MODE must be jwt or disabled.")
        self.auth_mode = raw_auth_mode

        # HS256 remains the dependency-free local/default verifier.  RS256 is
        # also supported for production providers that sign with an asymmetric
        # key.  The token header still cannot select the algorithm: it is
        # compared with this server-owned setting in backend.auth.
        self.jwt_algorithm = os.environ.get("JWT_ALGORITHM", "HS256").strip().upper()
        if self.jwt_algorithm not in {"HS256", "RS256"}:
            raise RuntimeError("JWT_ALGORITHM must be HS256 or RS256.")
        self.jwt_secret = (
            os.environ.get("JWT_SECRET")
            or os.environ.get("SUPABASE_JWT_SECRET")
            or ""
        ).strip()
        self.jwt_public_key = os.environ.get("JWT_PUBLIC_KEY", "").strip()
        # Values copied from secret managers commonly contain literal ``\\n``.
        # Normalize that representation without ever logging the key.
        if self.jwt_public_key:
            self.jwt_public_key = self.jwt_public_key.replace("\\n", "\n")
        self.jwt_jwks_url = os.environ.get("JWT_JWKS_URL", "").strip()
        self.jwt_key_id = os.environ.get("JWT_KEY_ID", "").strip()
        self.jwt_jwks_cache_seconds = _strict_bounded_env_float(
            "JWT_JWKS_CACHE_SECONDS",
            300.0,
            minimum=0.0,
            maximum=86400.0,
        )
        self.jwt_issuer = os.environ.get("JWT_ISSUER", "").strip()
        self.jwt_audience = os.environ.get("JWT_AUDIENCE", "").strip()
        self.jwt_clock_skew_seconds = _strict_bounded_env_float(
            "JWT_CLOCK_SKEW_SECONDS",
            30.0,
            minimum=0.0,
            maximum=300.0,
        )
        self.jwt_user_id_claim = os.environ.get(
            "JWT_USER_ID_CLAIM", "sub"
        ).strip()

        if self.auth_mode == "disabled":
            auth_problems: list[str] = []
            if self.use_supabase:
                auth_problems.append(
                    "AUTH_MODE=disabled is not allowed when USE_SUPABASE=true."
                )
            if self.app_env == "production":
                auth_problems.append(
                    "AUTH_MODE=disabled is not allowed in production."
                )
            if auth_problems:
                raise RuntimeError(
                    "Invalid authentication configuration: "
                    + "; ".join(auth_problems)
                )
        else:
            auth_problems = []
            if self.jwt_algorithm == "HS256":
                if not self.jwt_secret or _looks_like_placeholder(self.jwt_secret):
                    auth_problems.append(
                        "AUTH_MODE=jwt with JWT_ALGORITHM=HS256 requires a real "
                        "JWT_SECRET (or SUPABASE_JWT_SECRET) in the environment."
                    )
                elif len(self.jwt_secret.encode("utf-8")) < 32:
                    auth_problems.append("JWT secret must be at least 32 bytes.")
            else:
                has_static_key = bool(self.jwt_public_key) and not _looks_like_placeholder(
                    self.jwt_public_key
                )
                has_jwks = bool(self.jwt_jwks_url) and not _looks_like_placeholder(
                    self.jwt_jwks_url
                )
                if not has_static_key and not has_jwks:
                    auth_problems.append(
                        "JWT_ALGORITHM=RS256 requires a real JWT_PUBLIC_KEY or "
                        "JWT_JWKS_URL configured on the server."
                    )
                if has_jwks:
                    try:
                        parsed_jwks = urlparse(self.jwt_jwks_url)
                        parsed_jwks.port
                    except ValueError:
                        auth_problems.append("JWT_JWKS_URL is malformed.")
                    else:
                        if (
                            parsed_jwks.scheme not in {"http", "https"}
                            or not parsed_jwks.hostname
                            or parsed_jwks.username is not None
                            or parsed_jwks.password is not None
                            or parsed_jwks.query
                            or parsed_jwks.fragment
                        ):
                            auth_problems.append(
                                "JWT_JWKS_URL must be a plain http(s) URL without "
                                "credentials, query parameters, or fragments."
                            )
                        if self.app_env == "production" and parsed_jwks.scheme != "https":
                            auth_problems.append(
                                "JWT_JWKS_URL must use HTTPS in production."
                            )
            # Never accept a browser-visible Supabase key as a symmetric JWT
            # signing secret. These comparisons are unconditional: a key can
            # be present in a local environment even when USE_SUPABASE is off,
            # and accepting it would make every signed subject forgeable.
            if self.jwt_algorithm == "HS256":
                if self.jwt_secret and self.jwt_secret == self.supabase_publishable_key:
                    auth_problems.append(
                        "JWT secret must not be the browser-visible Supabase "
                        "publishable/anon key."
                    )
                if self.jwt_secret and self.jwt_secret == self.supabase_service_role_key:
                    auth_problems.append(
                        "JWT secret must not be SUPABASE_SERVICE_ROLE_KEY."
                    )
                if self.jwt_secret and self.jwt_secret == self.supabase_url:
                    auth_problems.append("JWT secret must not be SUPABASE_URL.")
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", self.jwt_user_id_claim):
                auth_problems.append(
                    "JWT_USER_ID_CLAIM must be a simple claim name."
                )
            if auth_problems:
                raise RuntimeError(
                    "Invalid authentication configuration: "
                    + "; ".join(auth_problems)
                )

        # V1 is the legacy, global catalog service.  It is intentionally
        # disabled by default for production/Supabase deployments because a
        # verified user alone cannot tenant-scope that global service.  Local
        # development keeps it available so the original demo/API contract
        # remains usable.  An explicit opt-in still requires authentication.
        raw_v1_enabled = os.environ.get("V1_ENABLED", "").strip().lower()
        if raw_v1_enabled in {"",}:
            self.v1_enabled = not (self.app_env == "production" or self.use_supabase)
        elif raw_v1_enabled in {"1", "true", "yes", "on"}:
            self.v1_enabled = True
        elif raw_v1_enabled in {"0", "false", "no", "off"}:
            self.v1_enabled = False
        else:
            raise RuntimeError("V1_ENABLED must be true/false, 1/0, yes/no, or on/off.")
        raw_v1_auth = os.environ.get("V1_REQUIRE_AUTH", "").strip().lower()
        if raw_v1_auth in {"",}:
            self.v1_require_auth = self.app_env == "production" or self.use_supabase
        elif raw_v1_auth in {"1", "true", "yes", "on"}:
            self.v1_require_auth = True
        elif raw_v1_auth in {"0", "false", "no", "off"}:
            if self.app_env == "production":
                raise RuntimeError(
                    "V1_REQUIRE_AUTH=false is not allowed in production."
                )
            self.v1_require_auth = False
        else:
            raise RuntimeError(
                "V1_REQUIRE_AUTH must be true/false, 1/0, yes/no, or on/off."
            )

        # Optional local password-backed issuer. It is deliberately opt-in and
        # cannot be enabled with Supabase or production: public deployments
        # should use a managed identity provider and the configured JWT
        # verifier instead of a homemade account system.
        raw_local_auth = os.environ.get("LOCAL_AUTH_ENABLED", "false").strip().lower()
        if raw_local_auth in {"", "0", "false", "no", "off"}:
            self.local_auth_enabled = False
        elif raw_local_auth in {"1", "true", "yes", "on"}:
            self.local_auth_enabled = True
        else:
            raise RuntimeError(
                "LOCAL_AUTH_ENABLED must be true/false, 1/0, yes/no, or on/off."
            )
        local_db = os.environ.get("LOCAL_DATABASE_PATH", "").strip()
        self.local_database_path = local_db or str(REPO_ROOT / "data" / "runtime" / "ecomai.sqlite3")
        self.local_auth_database_path = (
            os.environ.get("LOCAL_AUTH_DATABASE_PATH", "").strip()
            or self.local_database_path
        )
        self.access_token_ttl_seconds = _strict_bounded_env_float(
            "ACCESS_TOKEN_TTL_SECONDS",
            3600.0,
            minimum=60.0,
            maximum=86400.0,
        )
        if self.local_auth_enabled:
            if self.use_supabase or self.app_env == "production":
                raise RuntimeError(
                    "LOCAL_AUTH_ENABLED is not allowed with USE_SUPABASE=true or "
                    "APP_ENV=production."
                )
            if self.auth_mode != "jwt" or self.jwt_algorithm != "HS256":
                raise RuntimeError(
                    "LOCAL_AUTH_ENABLED requires AUTH_MODE=jwt and "
                    "JWT_ALGORITHM=HS256."
                )

        # Sizing/limits used by the ingestion & job layers. Invalid values
        # stay bounded instead of turning configuration into a traceback.
        self.max_upload_rows = _strict_bounded_env_int(
            "MAX_UPLOAD_ROWS", 250000, minimum=1, maximum=2_000_000
        )
        self.default_job_timeout_s = _strict_bounded_env_int(
            "DEFAULT_JOB_TIMEOUT_S", 300, minimum=1, maximum=86400
        )
        self.supabase_request_timeout_s = _bounded_env_float(
            "SUPABASE_REQUEST_TIMEOUT_S",
            10.0,
            minimum=0.1,
            maximum=120.0,
        )
        self.job_database_path = os.environ.get("JOB_DATABASE_PATH", "").strip() or str(
            REPO_ROOT / "data" / "runtime" / "jobs.sqlite3"
        )

        # If Supabase is requested, validate that the config is complete and
        # not placeholder-shaped. Fail fast — never run half-wired against a
        # fake credential.
        if self.use_supabase:
            self._validate_supabase_config()

    # ------------------------------------------------------------------
    def _validate_supabase_config(self) -> None:
        problems: list[str] = []

        if not self.supabase_url:
            problems.append("USE_SUPABASE=true but SUPABASE_URL is unset")
        elif not _is_valid_supabase_url(self.supabase_url):
            problems.append(
                "SUPABASE_URL must be a plain http(s) Supabase project URL "
                "without credentials, query parameters, or fragments"
            )
        elif _looks_like_placeholder(self.supabase_url):
            problems.append(
                "SUPABASE_URL is still a placeholder; set a real project URL "
                "in your local .env (never committed)."
            )

        # The publishable/anon key is optional for a server-only backend.  If
        # configured, it must still be real; the service-role key remains the
        # only privileged credential and is never exposed here.
        if self.supabase_publishable_key and _looks_like_placeholder(
            self.supabase_publishable_key
        ):
            problems.append(
                "SUPABASE_PUBLISHABLE_KEY is still a placeholder; set the real "
                "publishable key in your local .env."
            )

        if not self.supabase_service_role_key:
            problems.append(
                "USE_SUPABASE=true but SUPABASE_SERVICE_ROLE_KEY is unset "
                "(server-only secret)."
            )
        elif _looks_like_placeholder(self.supabase_service_role_key):
            problems.append(
                "SUPABASE_SERVICE_ROLE_KEY is still a placeholder; set the real "
                "service-role key in your local .env (never commit, never "
                "send to the frontend)."
            )

        if problems:
            raise RuntimeError(
                "Supabase is requested but configuration is invalid:\n- "
                + "\n- ".join(problems)
            )

    # ------------------------------------------------------------------
    # Public, secret-safe accessors
    # ------------------------------------------------------------------

    @property
    def public_supabase_config(self) -> dict:
        """Config that is SAFE to expose. Never includes service-role key."""
        return {
            "use_supabase": self.use_supabase,
            "supabase_url": self.supabase_url,
            "supabase_publishable_key": self.supabase_publishable_key,
        }

    def service_role_key_or_none(self) -> Optional[str]:
        """Return the server-side secret key if it is configured and real.

        Callers must ensure this value is used ONLY server-side (e.g. Supabase
        Admin/RLS bypass paths) and is never included in any API response.
        """
        if not self.use_supabase:
            return None
        if not self.supabase_service_role_key:
            return None
        if _looks_like_placeholder(self.supabase_service_role_key):
            return None
        return self.supabase_service_role_key
