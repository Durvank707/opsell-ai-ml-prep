"""Additive V2 router — validation jobs, eligibility, tenant isolation (§16/§33/§42/§43/§44).

Everything here delegates ONLY to real, on-disk public surfaces:

* ``backend.validation.validate_rows`` — canonical row validation report;
  large payloads return 202 + a job id instead of holding the request open.
* ``backend.eligibility.classify_tier / classify_tier_label /
  eligibility_for_history`` — deterministic tier + decision, no ML guessing.
* ``backend.jobs.JobRegistry`` — the async 202 → status job lifecycle.
* ``backend.auth.require_auth / resolve_tenant_id`` — server-side JWT
  verification and binding of every V2 request to the signed subject.
* ``backend.tenant.DEMO_USER_ID / DEMO_EMAIL / TenantWorkspace`` — per-user
  isolation; a second tenant opening a workspace NEVER sees the demo rows and
  NEVER reaches another user's products (``TenantIsolationError`` → 403).

No new modality is invented here: eligibility decides, jobs run, tenants are
isolated, and any per-product failure is isolated to that product (it never
fails the whole job) — exactly per §42/§43.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path as APIPath, Query, Response
from pydantic import BaseModel, Field

from backend.auth import AuthPrincipal, require_auth, resolve_tenant_id
from backend.jobs import JobRegistry
from backend.tenant import (
    DEMO_EMAIL,
    DEMO_USER_ID,
    TenantIsolationError,
    TenantWorkspace,
    seed_canonical_demo,
)
from backend.contracts import contract_for
from backend.validation import validate_rows

# Every V2 route is authenticated. Tenant-bearing route parameters and bodies
# are checked again against the signed principal inside each handler.
router = APIRouter(
    prefix="/api/v2",
    tags=["V2"],
    dependencies=[Depends(require_auth)],
)

# ---------------------------------------------------------------------------
# In-process multi-tenant store (canonical per-user workspaces).
#
# NOTE the demo user is the ONLY pre-seeded tenant, and it is seeded from the
# canonical raw sales walk (see tenant.py) — never from any other
# tenant's rows. Every other user starts EMPTY; there is NO code path
# that copies one tenant's rows into another tenant's workspace.
# ---------------------------------------------------------------------------

_WORKSPACES: Dict[str, TenantWorkspace] = {}


def workspace_for(user_id: str, email: Optional[str] = None) -> TenantWorkspace:
    """Return the user-scoped workspace, creating an empty one on first sight.

    The demo user is seeded via the canonical walk when this store lazily
    brings up that workspace (see ``_seed_canonical_demo``). Any other user —
    including a *new* tenant — always starts with an EMPTY workspace: this
    function NEVER copies another tenant's rows.
    """
    if user_id is None:
        raise ValueError("user_id is required to open a tenant workspace.")
    user_id = str(user_id).strip()
    if not user_id:
        raise ValueError("user_id is required to open a tenant workspace.")
    ws = _WORKSPACES.get(user_id)
    if ws is None:
        ws = TenantWorkspace(user_id=user_id, email=email or user_id)
        _WORKSPACES[user_id] = ws
    # Hydrate only the explicit Supabase path.  The default local path makes
    # no network call and starts new tenants with a genuinely empty workspace.
    from backend.supabase import supabase_enabled

    if supabase_enabled() and not ws.remote_hydrated:
        ws.hydrate_sales()
    if ws.user_id == DEMO_USER_ID and not ws.products and not ws.sales_records:
        _seed_canonical_demo()
    return ws


def _seed_canonical_demo() -> None:
    """Lazily seed only the canonical demo workspace from the on-disk CSV.

    The actual walk lives in :func:`backend.tenant.seed_canonical_demo` so
    there is one canonical seeding path.  Keeping the router wrapper small
    also means the router does not carry a second, drifting row-binding
    implementation.
    """
    demo = _WORKSPACES.get(DEMO_USER_ID)
    if demo is None:
        demo = TenantWorkspace(user_id=DEMO_USER_ID, email=DEMO_EMAIL)
        _WORKSPACES[DEMO_USER_ID] = demo
    if not demo.products:
        seed_canonical_demo(demo)


def get_workspace(user_id: str, email: Optional[str] = None) -> TenantWorkspace:
    try:
        ws = workspace_for(user_id, email)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except RuntimeError as exc:
        from backend.supabase import friendly_hint_for

        raise HTTPException(status_code=503, detail=friendly_hint_for(exc)) from exc
    if ws.user_id == DEMO_USER_ID and not ws.products and not ws.sales_records:
        _seed_canonical_demo()
    return ws


# ---------------------------------------------------------------------------
# Pydantic surfaces (additive — mirrors naming from backend/schemas.py).
# ---------------------------------------------------------------------------


class V2ValidateRequest(BaseModel):
    user_id: str = Field(
        ..., min_length=1, description="Tenant id; rows are never tenant-crossed."
    )
    record_type: str = Field(
        default="sales", min_length=1, description="Canonical contract key."
    )
    rows: List[Dict[str, Any]] = Field(default_factory=list)
    mapping: Dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Optional column mapping. Both raw→canonical and canonical→raw "
            "forms are accepted; empty means alias detection."
        ),
    )
    columns: List[str] = Field(
        default_factory=list,
        description="Declared source columns; useful for an empty or broken file.",
    )
    known_categories: List[str] = Field(default_factory=list)
    max_rows: Optional[int] = Field(default=None, ge=1)


class V2EligibilityRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    product_id: str = Field(..., min_length=1)
    history_days: Optional[int] = Field(default=None, ge=0)
    model_available: Optional[bool] = True
    required_fields_present: bool = True
    numeric_types_ok: bool = True
    had_error_problems: int = Field(default=0, ge=0)
    category_known: bool = True
    feature_values_in_range: bool = True
    feature_gap: List[str] = Field(default_factory=list)


class V2EligibilityPathRequest(V2EligibilityRequest):
    """Path-form eligibility body; the path supplies product_id when omitted."""

    product_id: Optional[str] = Field(default=None, min_length=1)


class V2ForecastRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    product_id: str = Field(..., min_length=1)
    # Optional transient input; when omitted, the tenant's persisted history
    # is used.  It is validated against the same sales contract before use.
    history: Optional[List[Dict[str, Any]]] = None
    model_available: Optional[bool] = True


class V2JobStatusRequest(BaseModel):
    job_id: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _configured_max_rows() -> int:
    """Read the server-owned upload cap, including values from a local .env."""
    try:
        from backend.config import Settings

        return max(1, Settings().max_upload_rows)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail="Server configuration is not ready. Please try again later.",
        ) from exc


def _decision_payload(product_id: str, history_days: int, request: V2EligibilityRequest) -> dict:
    """Build a complete, auditable eligibility response."""
    from backend.eligibility import ModelEligibilityCheck

    checker = ModelEligibilityCheck(
        model_available=(
            True if request.model_available is None else bool(request.model_available)
        ),
        model_features=("price", "promotion", "units_sold"),
    )
    decision = checker.evaluate(
        history_days=history_days,
        required_fields_present=request.required_fields_present,
        numeric_types_ok=request.numeric_types_ok,
        had_error_problems=request.had_error_problems,
        category_known=request.category_known,
        feature_values_in_range=request.feature_values_in_range,
        feature_gap=request.feature_gap,
    )
    payload = {"product_id": product_id, "history_days": history_days}
    payload.update(decision.to_dict())
    payload["gates"] = [gate.to_dict() for gate in getattr(decision, "gates", [])]
    return payload


@router.post("/validate")
async def validate_rows_v2(
    request: V2ValidateRequest,
    response: Response,
    principal: AuthPrincipal = Depends(require_auth),
):
    """Validate rows against the canonical contract; large payloads → 202 job.

    Small files get the report inline; files over ``_INLINE_LIMIT`` rows are
    processed asynchronously as a job (202 + ``job_id``) so a slow/big upload
    never holds the request open.
    """
    user_id = resolve_tenant_id(principal, request.user_id)
    try:
        contract = contract_for(request.record_type)
    except NameError as e:
        raise HTTPException(status_code=422, detail=str(e))

    mapping = request.mapping
    declared_columns = request.columns or None
    category_fields = getattr(request, "model_fields_set", None)
    if category_fields is None:  # Pydantic v1 compatibility
        category_fields = getattr(request, "__fields_set__", set())
    if request.known_categories:
        known_categories = set(request.known_categories)
    elif "known_categories" in category_fields:
        # Distinguish an explicitly supplied empty universe from an omitted
        # optional list; the validator treats empty as an unknown-category
        # gate rather than silently treating it as "no check".
        known_categories = set()
    else:
        known_categories = None
    configured_limit = _configured_max_rows()
    # ``max_rows`` may make a client request stricter, but it can never raise
    # the server's hard upload cap.
    row_limit = (
        min(request.max_rows, configured_limit)
        if request.max_rows is not None
        else configured_limit
    )

    if len(request.rows) > row_limit:
        result = validate_rows(
            request.rows,
            contract,
            mapping=mapping,
            columns=declared_columns,
            known_categories=known_categories,
            max_rows=row_limit,
        )
        response.status_code = 413
        return {
            "total_rows": result.total_rows,
            "accepted_rows": result.accepted_rows,
            "rejected_rows": result.rejected_rows,
            "problems": [p.to_dict() for p in result.problems],
            "schema_problems": [p.to_dict() for p in result.schema_problems],
        }

    # Async path for large files (202) --------------------------------------
    if len(request.rows) > _INLINE_LIMIT:
        reg = _job_registry()
        try:
            job = reg.create_job(
                user_id=user_id,
                job_type=f"validate:{request.record_type}",
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        # NOTE: job.run starts the protected execution; result attached to job.
        reg.start(job, _async_validate(
            contract,
            request.rows,
            mapping,
            columns=declared_columns,
            known_categories=known_categories,
        ))
        response.status_code = 202
        return {
            "job_id": job.job_id,
            "status": job.status,
            "detail": f"Validating {len(request.rows)} rows asynchronously.",
        }

    result = validate_rows(
        request.rows,
        contract,
        mapping=mapping,
        columns=declared_columns,
        known_categories=known_categories,
        max_rows=request.max_rows,
    )
    return {
        "total_rows": result.total_rows,
        "accepted_rows": result.accepted_rows,
        "rejected_rows": result.rejected_rows,
        "problems": [p.to_dict() for p in result.problems],
        "schema_problems": [p.to_dict() for p in result.schema_problems],
    }


_INLINE_LIMIT = 500


@router.post("/eligibility/check")
async def check_eligibility(
    request: V2EligibilityRequest,
    principal: AuthPrincipal = Depends(require_auth),
):
    """Return the complete model-eligibility decision for one product."""
    resolve_tenant_id(principal, request.user_id)
    if not str(request.product_id).strip():
        raise HTTPException(status_code=422, detail="product_id cannot be blank.")
    history_days = request.history_days or 0
    return _decision_payload(request.product_id, history_days, request)


@router.get("/eligibility/{product_id}")
@router.post("/eligibility/{product_id}")
async def check_product_eligibility(
    principal: AuthPrincipal = Depends(require_auth),
    product_id: str = APIPath(..., min_length=1),
    history_days: int = Query(default=0, ge=0),
    user_id: Optional[str] = Query(default=None, min_length=1),
    body: Optional[V2EligibilityPathRequest] = None,
):
    """Deterministic eligibility tier + decision for one product's history.

    The path form is convenient for a simple query.  POST callers may send the
    same complete decision-request body as ``/eligibility/check``; when it is
    present, its product id must agree with the path rather than being guessed.
    """
    if not str(product_id).strip():
        raise HTTPException(status_code=422, detail="product_id cannot be blank.")
    if body is None:
        # This branch is a deterministic, non-persisted eligibility query. A
        # supplied query tenant is still checked against the signed subject;
        # omitting it is allowed because no tenant state is read.
        if user_id is not None:
            resolve_tenant_id(principal, user_id)
        request = V2EligibilityRequest(
            user_id=principal.user_id or "local-query",
            product_id=product_id,
            history_days=history_days,
            model_available=True,
        )
        effective_history_days = history_days
    else:
        resolve_tenant_id(principal, body.user_id)
        if user_id is not None:
            resolve_tenant_id(principal, user_id)
        if body.product_id is not None:
            if not str(body.product_id).strip() or str(body.product_id).strip() != product_id:
                raise HTTPException(
                    status_code=422,
                    detail="Body product_id must match the path product_id.",
                )
        request = body
        effective_history_days = (
            body.history_days if body.history_days is not None else history_days
        )
    return _decision_payload(product_id, effective_history_days, request)


@router.post("/forecast")
async def forecast_v2(
    request: V2ForecastRequest,
    principal: AuthPrincipal = Depends(require_auth),
):
    """Generate a tenant-scoped forecast through the eligibility gate."""
    if not str(request.product_id).strip():
        raise HTTPException(status_code=422, detail="product_id cannot be blank.")
    user_id = resolve_tenant_id(principal, request.user_id)
    ws = get_workspace(user_id, email=principal.email)
    try:
        return ws.forecast_for(
            request.product_id,
            model_available=(
                True if request.model_available is None else bool(request.model_available)
            ),
            history=request.history,
        )
    except TenantIsolationError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/jobs")
async def create_async_job(
    response: Response,
    principal: AuthPrincipal = Depends(require_auth),
    user_id: str = Query(..., min_length=1),
    job_type: str = Query(..., min_length=1),
):
    """Register an async job; returns 202 with a queued job id.

    Payload-free generic jobs are queue registrations: they remain queued
    until a real worker supplies an executable operation. The validation route
    below uses the same registry and supplies that operation directly.
    """
    user_id = resolve_tenant_id(principal, user_id)
    reg = _job_registry()
    try:
        job = reg.create_job(user_id=user_id, job_type=job_type)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    response.status_code = 202
    return {"job_id": job.job_id, "status": job.status}


@router.get("/jobs/{job_id}")
async def job_status(
    principal: AuthPrincipal = Depends(require_auth),
    job_id: str = APIPath(..., min_length=1),
    user_id: str = Query(..., min_length=1),
):
    """Friendly job status; the job stays scoped to its creator's user."""
    if not str(job_id).strip():
        raise HTTPException(status_code=422, detail="job_id is required.")
    user_id = resolve_tenant_id(principal, user_id)
    reg = _job_registry()
    job = reg.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job.user_id != str(user_id).strip():
        raise HTTPException(status_code=403, detail="That job belongs to another user.")
    return job.to_dict()


@router.get("/overview/{user_id}")
async def tenant_overview(
    principal: AuthPrincipal = Depends(require_auth),
    user_id: str = APIPath(..., min_length=1),
):
    """User-scoped inventory/health overview with audit trail (§44)."""
    user_id = resolve_tenant_id(principal, user_id)
    ws = get_workspace(user_id, email=principal.email)
    return {
        "user_id": ws.user_id,
        "products": len(ws.products),
        "sales_rows": len(ws.sales_records),
        "audit_entries": len(ws.audit),
    }


@router.get("/audit/{user_id}")
async def tenant_audit(
    principal: AuthPrincipal = Depends(require_auth),
    user_id: str = APIPath(..., min_length=1),
):
    """Append-only audit trail for one tenant (never another's)."""
    user_id = resolve_tenant_id(principal, user_id)
    ws = get_workspace(user_id, email=principal.email)
    return {
        "user_id": ws.user_id,
        "audit": [
            {
                "id": entry.id,
                "user_id": entry.user_id,
                "action": entry.action,
                "product_id": entry.product_id,
                "detail": entry.detail,
                "created_at": entry.created_at,
            }
            for entry in ws.audit
        ],
    }


@router.get("/isolated/{other_user_id}")
async def isolation_probe(
    principal: AuthPrincipal = Depends(require_auth),
    other_user_id: str = APIPath(..., min_length=1),
    user_id: str = Query(..., min_length=1),
    product_id: Optional[str] = Query(default=None, min_length=1),
):
    """Verify that a caller is not given the other tenant's workspace state.

    This is a local, non-leaking probe: it never returns the other workspace's
    products, row counts, or audit entries.  When ``product_id`` is supplied,
    the caller's own workspace is queried only; a product absent there is the
    expected ``isolated`` result, not permission to read the other tenant.
    """
    caller_id = resolve_tenant_id(principal, user_id)
    other_id = str(other_user_id).strip()
    if not other_id:
        raise HTTPException(status_code=422, detail="other_user_id is required.")
    if product_id is not None and not str(product_id).strip():
        raise HTTPException(status_code=422, detail="product_id cannot be blank.")
    if caller_id == other_id:
        raise HTTPException(status_code=400, detail="Choose a different user for an isolation check.")

    caller = get_workspace(caller_id, email=principal.email)
    product_is_visible = False
    if product_id is not None:
        try:
            caller.sales_history_for(product_id)
            product_is_visible = True
        except TenantIsolationError:
            product_is_visible = False

    return {
        "user_id": caller.user_id,
        "other_user_id": other_id,
        "isolated": True,
        "product_visible_to_caller": product_is_visible,
        "detail": "The caller's workspace was queried; no other tenant state was returned.",
    }


# ---------------------------------------------------------------------------
# Job plumbing (module-local registry mirroring backend/jobs.py surface).
# ---------------------------------------------------------------------------

_JOB_REGISTRY: Optional[JobRegistry] = None


def _job_registry() -> JobRegistry:
    global _JOB_REGISTRY
    if _JOB_REGISTRY is None:
        _JOB_REGISTRY = JobRegistry()
    return _JOB_REGISTRY


async def _async_validate(
    contract,
    rows,
    mapping,
    *,
    columns=None,
    known_categories=None,
):
    """Run the real validation in a background task; NEVER fabricate a result."""
    import asyncio

    await asyncio.sleep(0.001)
    result = validate_rows(
        rows,
        contract,
        mapping=mapping,
        columns=columns,
        known_categories=known_categories,
    )
    return {
        "total_rows": result.total_rows,
        "accepted_rows": result.accepted_rows,
        "rejected_rows": result.rejected_rows,
        "problems": [p.to_dict() for p in result.problems],
        "schema_problems": [p.to_dict() for p in result.schema_problems],
    }


# Re-export the canonical taxonomy so routers never import contracts twice.
from backend.contracts import ValidationProblemCategories  # noqa: E402,F401
