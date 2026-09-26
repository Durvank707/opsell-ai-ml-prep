"""Shared pytest configuration.

The test suite must be hermetic: it must never inherit a developer's local
`.env`, real Supabase credentials, or ambient JWT configuration. Results would
otherwise depend on whatever happens to sit on the machine.

Every test runs against an explicit in-test environment. Individual tests may
still `monkeypatch.setenv` to exercise a specific configuration.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# A path that cannot exist makes ``.env`` discovery a no-op, so no developer or
# CI ``.env`` file can leak into a test run.
os.environ["ECOMAI_OS_ENV_FILE"] = str(REPO_ROOT / "tests" / "_no_env_file_")

# Baseline: local, non-Supabase, HS256 with a throwaway test-only secret.
_BASELINE = {
    "APP_ENV": "test",
    "USE_SUPABASE": "false",
    "AUTH_MODE": "jwt",
    "JWT_ALGORITHM": "HS256",
    "JWT_SECRET": "test-only-not-a-real-secret-" + "0" * 32,
    "JWT_CLOCK_SKEW_SECONDS": "0",
    "JWT_USER_ID_CLAIM": "sub",
    "LOCAL_AUTH_ENABLED": "false",
    "V1_ENABLED": "true",
    "V1_REQUIRE_AUTH": "false",
}

# Remove anything that could otherwise survive from the ambient shell.
for _key in (
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_JWT_SECRET",
    "JWT_ISSUER",
    "JWT_AUDIENCE",
    "JWT_PUBLIC_KEY",
    "JWT_JWKS_URL",
    "JWT_KEY_ID",
    "LOCAL_AUTH_DATABASE_PATH",
    "LOCAL_DATABASE_PATH",
    "JOB_DATABASE_PATH",
    "CORS_ORIGINS",
):
    os.environ.pop(_key, None)

os.environ.update(_BASELINE)
