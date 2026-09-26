"""V2 API surface for EcomAI-OS (additive — never touches the V1 routes).

Routers in this package are mounted via ``app.include_router`` in
``backend/main.py`` under the ``/api/v2`` prefix. Every symbol imported here
comes straight from the canonical modules on disk (validation, eligibility,
jobs, tenant, contracts) — nothing is invented, no arity is guessed, failures
are never silent and never dumped as raw tracebacks.
"""
