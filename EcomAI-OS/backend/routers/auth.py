"""Optional local development authentication endpoints.

These routes are intentionally mounted outside the V2 tenant router because
signup/login must be reachable before a bearer token exists. They are only
available when ``LOCAL_AUTH_ENABLED=true``; production and Supabase
configuration fail closed in :class:`backend.config.Settings`.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from backend.auth import AuthPrincipal, require_auth
from backend.config import Settings
from backend.local_auth import (
    DuplicateEmailError,
    InvalidCredentialsError,
    LocalAuthError,
    get_store,
    issue_access_token,
)

router = APIRouter(prefix="/api/auth", tags=["Authentication"])


class SignupRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=256)
    fullName: str = Field(default="", max_length=120)
    businessName: str = Field(default="", max_length=160)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=256)


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
