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
from backend.validation import SEV_ERROR, validate_rows

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
        # Products, sales, and audit history are all durable when Supabase is
        # enabled, so the workspace is restored in one pass rather than sales
        # only. A failure raises out of here and is surfaced as a 503; it is
        # never downgraded to an empty in-memory workspace.
        ws.hydrate_from_supabase()
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


class V2IngestRequest(BaseModel):
    """Canonical rows to persist into the authenticated tenant's workspace.

    ``user_id`` is accepted for symmetry with the other V2 bodies but is
    re-checked against the signed principal: a caller can never write into
    another tenant's workspace by changing this field.
    """

    user_id: str = Field(..., min_length=1)
    record_type: str = Field(
        default="sales",
        min_length=1,
        description="Canonical contract key to ingest: 'sales' or 'product'.",
    )
    rows: List[Dict[str, Any]] = Field(default_factory=list)
    mapping: Dict[str, str] = Field(default_factory=dict)
    columns: List[str] = Field(default_factory=list)
    known_categories: List[str] = Field(default_factory=list)
    max_rows: Optional[int] = Field(default=None, ge=1)


# Ingest is a *write*. Only these two contracts have a durable home in the
# tenant schema, so anything else is refused rather than silently validated and
# dropped. ``inventory`` is deliberately absent by design.
_INGESTABLE_CONTRACTS = frozenset({"sales", "product"})


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


@router.post("/ingest")
async def ingest_rows_v2(
    request: V2IngestRequest,
    principal: AuthPrincipal = Depends(require_auth),
):
    """Validate canonical rows and persist them into the caller's workspace.

    This is the authenticated write path that makes Supabase (when
    ``USE_SUPABASE=true``) the durable store instead of a read-only mirror. It
    deliberately mirrors :func:`validate_rows_v2`'s validation semantics and
    adds the one thing that route intentionally does not do: commit.

    Guarantees:

    * The tenant is the **signed** subject. A mismatched ``user_id`` is a 403
      and nothing is written.
    * All-or-nothing. If any row fails canonical validation the whole batch is
      refused with 422 and no row and no audit entry is written, so a tenant
      never ends up with a half-ingested dataset.
    * The server upload cap is enforced and can never be raised by the client.
    * A failed remote write propagates as 503. It is never downgraded to a
      local-only success.
    """

    user_id = resolve_tenant_id(principal, request.user_id)

    if request.record_type not in _INGESTABLE_CONTRACTS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"'{request.record_type}' cannot be ingested. Ingestable "
                f"contracts: {sorted(_INGESTABLE_CONTRACTS)}."
            ),
        )
    try:
        contract = contract_for(request.record_type)
    except NameError as e:
        raise HTTPException(status_code=422, detail=str(e))

    if not request.rows:
        raise HTTPException(
            status_code=422, detail="No rows were supplied to ingest."
        )

    configured_limit = _configured_max_rows()
    row_limit = (
        min(request.max_rows, configured_limit)
        if request.max_rows is not None
        else configured_limit
    )
    if len(request.rows) > row_limit:
        raise HTTPException(
            status_code=413,
            detail=(
                f"{len(request.rows)} rows exceeds the accepted limit of "
                f"{row_limit}."
            ),
        )

    category_fields = getattr(request, "model_fields_set", None)
    if category_fields is None:  # Pydantic v1 compatibility
        category_fields = getattr(request, "__fields_set__", set())
    if request.known_categories:
        known_categories: Optional[set] = set(request.known_categories)
    elif "known_categories" in category_fields:
        known_categories = set()
    else:
        known_categories = None

    result = validate_rows(
        request.rows,
        contract,
        mapping=request.mapping,
        columns=request.columns or None,
        known_categories=known_categories,
        max_rows=row_limit,
    )
    blocking = [
        problem
        for problem in result.problems
        if problem.severity == SEV_ERROR
    ]
    if result.rejected_rows or result.schema_problems or blocking:
        # Nothing is persisted: report the problems and let the caller fix the
        # source. A partial write would leave the tenant's history unreproducible.
        raise HTTPException(
            status_code=422,
            detail={
                "message": (
                    "No rows were ingested because the batch did not validate. "
                    "Fix the reported rows and resubmit the whole batch."
                ),
                "total_rows": result.total_rows,
                "accepted_rows": result.accepted_rows,
                "rejected_rows": result.rejected_rows,
                "problems": [p.to_dict() for p in result.problems],
                "schema_problems": [p.to_dict() for p in result.schema_problems],
            },
        )

    ws = get_workspace(user_id, email=getattr(principal, "email", None))
    canonical_rows = [row.values for row in result.rows]
    try:
        if request.record_type == "product":
            written = len(ws.add_products(canonical_rows))
            persisted_table = "products"
        else:
            missing = sorted({
                str(row["product_id"])
                for row in canonical_rows
                if str(row["product_id"]) not in ws.products
            })
            if missing:
                # Refuse rather than auto-creating catalog rows from a sales
                # file: the product catalog is the tenant's own metadata and a
                # typo must not silently invent a product.
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "No rows were ingested because these product_id values "
                        f"are not in your catalog: {missing}. Ingest the "
                        "'product' contract first."
                    ),
                )
            written = ws.upsert_sales_rows(canonical_rows)
            persisted_table = "sales"
    except HTTPException:
        raise
    except TenantIsolationError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except RuntimeError as exc:
        from backend.supabase import friendly_hint_for

        raise HTTPException(status_code=503, detail=friendly_hint_for(exc)) from exc

    from backend.supabase import supabase_enabled

    durable = supabase_enabled()
    return {
        "record_type": request.record_type,
        "total_rows": result.total_rows,
        "ingested_rows": written,
        "persisted_to": persisted_table if durable else "memory",
        "durable": durable,
        "warnings": [p.to_dict() for p in result.problems],
    }


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
