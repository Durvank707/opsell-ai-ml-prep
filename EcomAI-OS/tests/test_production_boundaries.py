"""Focused regression tests for production boundaries introduced with V2."""

from __future__ import annotations

import asyncio
import os
import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend import local_auth
from backend.auth import verify_jwt
from backend.config import Settings
from backend.jobs import JobRegistry
from backend.main import app
from backend.routers import v2


client = TestClient(app)


@pytest.fixture
def server_env(monkeypatch):
    """Keep environment-sensitive tests explicit and isolated."""

    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")
    monkeypatch.setenv("JWT_SECRET", "test-" + "x" * 48)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "false")
    monkeypatch.setenv("V1_ENABLED", "true")
    monkeypatch.setenv("V1_REQUIRE_AUTH", "false")
    for key in (
        "SUPABASE_JWT_SECRET",
        "JWT_ISSUER",
        "JWT_AUDIENCE",
        "JWT_PUBLIC_KEY",
        "JWT_JWKS_URL",
    ):
        monkeypatch.delenv(key, raising=False)


def test_local_auth_is_opt_in_real_hs256_and_password_safe(tmp_path, monkeypatch, server_env):
    database = tmp_path / "local-auth.sqlite3"
    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "true")
    monkeypatch.setenv("LOCAL_AUTH_DATABASE_PATH", str(database))
    settings = Settings()
    store = local_auth.LocalAuthStore(settings.local_auth_database_path)
    try:
        user = store.create_user(
            email="person@example.com",
            password="correct horse battery",
            display_name="Person",
        )
        assert user["id"]
        assert store.authenticate(
            email=" PERSON@EXAMPLE.COM ", password="correct horse battery"
        )["id"] == user["id"]
        token = local_auth.issue_access_token(user, settings)
        principal = verify_jwt(token, settings)
        assert principal.user_id == user["id"]
        assert principal.email == "person@example.com"
    finally:
        store.close()

    raw_database = database.read_bytes()
    assert b"correct horse battery" not in raw_database
    assert b"password_hash" not in raw_database or b"correct horse battery" not in raw_database

    # A newly constructed store can authenticate the same durable account.
    reopened = local_auth.LocalAuthStore(str(database))
    try:
        assert reopened.authenticate(
            email="person@example.com", password="correct horse battery"
        )["id"] == user["id"]
    finally:
        reopened.close()


def test_local_auth_routes_issue_and_restore_a_server_token(tmp_path, monkeypatch, server_env):
    database = tmp_path / "route-auth.sqlite3"
    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "true")
    monkeypatch.setenv("LOCAL_AUTH_DATABASE_PATH", str(database))
    local_auth.reset_store()
    try:
        signup = client.post(
            "/api/auth/signup",
            json={
                "email": "route@example.com",
                "password": "route-password",
                "fullName": "Route User",
            },
        )
        assert signup.status_code == 201, signup.text
        body = signup.json()
        assert body["token_type"] == "bearer"
        token = body["access_token"]

        me = client.get(
            "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
        )
        assert me.status_code == 200
        assert me.json()["user"]["email"] == "route@example.com"

        duplicate = client.post(
            "/api/auth/signup",
            json={"email": "route@example.com", "password": "route-password"},
        )
        assert duplicate.status_code == 409
    finally:
        local_auth.reset_store()


def test_production_health_is_public_liveness_only_and_v1_is_protected(monkeypatch, server_env):
    import backend.main as main_module

    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("V1_ENABLED", "true")
    monkeypatch.setenv("V1_REQUIRE_AUTH", "true")
    monkeypatch.setattr(
        main_module,
        "get_service",
        lambda: (_ for _ in ()).throw(AssertionError("health loaded ML service")),
    )

    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json() == {"status": "healthy"}

    protected = client.get("/api/products")
    assert protected.status_code == 401
    assert protected.json() == {"detail": "Authentication is required."}


def test_v1_auth_cannot_be_bypassed_with_disabled_auth(monkeypatch, server_env):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("AUTH_MODE", "disabled")
    monkeypatch.setenv("V1_REQUIRE_AUTH", "true")

    response = client.get("/api/products")
    assert response.status_code == 503
    assert response.json() == {
        "detail": "V1 authentication is required but AUTH_MODE is disabled."
    }


def test_job_lifecycle_survives_registry_restart_and_recovers_running_rows(tmp_path):
    database = tmp_path / "jobs.sqlite3"
    registry = JobRegistry(str(database), timeout_seconds=1.0)
    job = registry.create_job(user_id="tenant-a", job_type="validation")
    registry.mark_running(job)
    registry.close()

    restarted = JobRegistry(str(database), timeout_seconds=1.0)
    try:
        recovered = restarted.get_job(job.job_id)
        assert recovered is not None
        assert recovered.status == "failed"
        assert "interrupted" in recovered.error_detail

        durable = restarted.create_job(user_id="tenant-a", job_type="validation")
        restarted.close()
        reopened = JobRegistry(str(database), timeout_seconds=1.0)
        try:
            assert reopened.get_job(durable.job_id).status == "queued"
        finally:
            reopened.close()
    finally:
        # ``restarted`` may already be closed in the assertion path.
        try:
            restarted.close()
        except Exception:
            pass


def test_job_timeout_and_persisted_error_redaction(tmp_path):
    database = tmp_path / "jobs.sqlite3"

    async def exercise():
        registry = JobRegistry(str(database), timeout_seconds=0.01)

        timed = registry.create_job(user_id="tenant-a", job_type="slow")
        task = registry.start(timed, asyncio.sleep(1))
        await task
        assert timed.status == "failed"
        assert "time limit" in (timed.error_detail or "")

        failed = registry.create_job(user_id="tenant-a", job_type="bad")
        task = registry.start(
            failed,
            _raise_with_secret(),
        )
        await task
        assert failed.status == "failed"
        assert "secret-value" not in (failed.error_detail or "")
        registry.close()

    asyncio.run(exercise())
    reopened = JobRegistry(str(database), timeout_seconds=1.0)
    try:
        failed = next(job for job in reopened.list_jobs("tenant-a") if job.job_type == "bad")
        assert "secret-value" not in (failed.error_detail or "")
    finally:
        reopened.close()


async def _raise_with_secret():
    raise RuntimeError("Authorization: Bearer secret-value")


def test_local_auth_is_rejected_for_production(monkeypatch, server_env):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("V1_REQUIRE_AUTH", "true")
    monkeypatch.setenv("LOCAL_AUTH_ENABLED", "true")
    with pytest.raises(RuntimeError, match="LOCAL_AUTH_ENABLED"):
        Settings()


def test_explicit_env_file_opt_out_ignores_the_repo_dotenv(monkeypatch, tmp_path):
    """An explicit ECOMAI_OS_ENV_FILE must be the only .env considered.

    This is what keeps the suite from inheriting real Supabase credentials
    from a developer's local ``.env``.
    """

    import backend.config as config_module

    decoy = tmp_path / "decoy.env"
    decoy.write_text("USE_SUPABASE=true\nAPP_ENV=production\n", encoding="utf-8")
    missing = tmp_path / "absent.env"
    monkeypatch.setenv("ECOMAI_OS_ENV_FILE", str(missing))
    for key in ("USE_SUPABASE", "APP_ENV"):
        monkeypatch.delenv(key, raising=False)

    config_module._load_dotenv_files()
    assert "USE_SUPABASE" not in os.environ
    assert "APP_ENV" not in os.environ

    monkeypatch.setenv("ECOMAI_OS_ENV_FILE", str(decoy))
    config_module._load_dotenv_files()
    assert os.environ["USE_SUPABASE"] == "true"
    assert os.environ["APP_ENV"] == "production"


def test_v2_workspace_lookup_never_returns_another_tenants_rows(monkeypatch, server_env):
    v2._WORKSPACES.clear()
    first = v2.get_workspace("tenant-a")
    second = v2.get_workspace("tenant-b")
    first.add_product(
        {"product_id": "A1", "product_name": "A", "current_stock": 2}
    )
    assert "A1" in first.products
    assert "A1" not in second.products
    assert second.products == {}
