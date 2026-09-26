"""ML model eligibility & safe-fallback decisions.

Implements the spec's Model Eligibility Check (§42) and the history-length
tiers (§15/§16/§17/§43):

    < 30 days            → ML forecast unavailable  → baseline (fallback, labeled)
    30–89 days           → preliminary forecast     → baseline, limited-history warn
    90–179 days          → ML forecast ALLOWED      → limited-confidence warn
    180–364 days         → preferred range
    365+ days            → especially valuable (annual/seasonal signal)

Every decision is *provisional*: eligibility alone never guarantees accuracy
(§43). The engine returns the decision, the reason, the fallback that was
used, and the model version that applies. Callers never block an eligible
product on an unavailable model — they fall back *safely* to baseline and
label it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# History tiers — same thresholds the docs & UI use
# ---------------------------------------------------------------------------

TIER_COLD = "cold_start"
TIER_SHORT = "short_history"
TIER_LIMITED = "limited_history"
TIER_PREFERRED = "preferred_range"
# Keep the machine-readable tier name explicit: it is consumed by API clients
# and audits, while the human-facing copy below remains "Annual history".
TIER_ANNUAL = "annual_history"

# Label copy for each tier.
TIER_LABELS: Dict[str, str] = {
    TIER_COLD: "Cold start",
    TIER_SHORT: "Short history",
    TIER_LIMITED: "Limited history",
    TIER_PREFERRED: "Preferred range",
    TIER_ANNUAL: "Annual history",
}

# Friendly descriptive copy per tier (shown to the user, no slash/stack-trace).
TIER_DESCRIPTIONS: Dict[str, str] = {
    TIER_COLD: ("No ML forecast is generated because the product does not yet "
                "have enough sales history. A baseline estimate is shown "
                "instead while history accumulates."),
    TIER_SHORT: ("The product has 30–89 days of history. A preliminary ML "
                 "forecast is NOT offered as high-confidence; a baseline "
                 "estimate is shown with a limited-history warning."),
    TIER_LIMITED: ("The product has 90–179 days of history. ML is allowed but "
                   "marked as limited-confidence until more history exists."),
    TIER_PREFERRED: ("The product has 180–364 days of history. This is the "
                     "preferred range for a reliable ML forecast."),
    TIER_ANNUAL: ("The product has 365+ days of history, which is especially "
                  "useful for annual and seasonal demand patterns."),
}

MODEL_VERSION = "xgboost-v1.0.0"

EVENT_KEYS = ("units_sold",)
TIER_THRESHOLDS = (
    0, 30, 90, 180, 365,
)


def classify_tier(history_days: int) -> str:
    """Return the history tier for ``history_days`` observed sales days."""
    if history_days < TIER_THRESHOLDS[1]:      # < 30
        return TIER_COLD
    if history_days < TIER_THRESHOLDS[2]:      # 30–89
        return TIER_SHORT
    if history_days < TIER_THRESHOLDS[3]:      # 90–179
        return TIER_LIMITED
    if history_days < TIER_THRESHOLDS[4]:      # 180–364
        return TIER_PREFERRED
    return TIER_ANNUAL                          # 365+


def classify_tier_label(history_days: int) -> str:
    """Return the stable machine tier identifier for ``history_days``.

    ``EligibilityDecision.tier_label`` carries the human-facing copy; this
    helper intentionally remains the canonical enum-like value so API clients
    and audits can compare tiers without relying on translated display text.
    Negative/zero history follows the same deterministic cold-start branch.
    """
    return classify_tier(history_days)


def eligibility_for_history(history_days: int, model_available: bool) -> EligibilityDecision:
    """Compute the ML-eligibility + safe-fallback decision for one product.

    Returns a self-contained decision; the caller applies it. The decision
    records *what* was used, *why*, and with *what confidence label* so it can
    be audited (spec §44) without guessing later.
    """
    tier = classify_tier(history_days)
    requested_ml = model_available and history_days >= TIER_THRESHOLDS[2]  # 90+
    eligible = requested_ml
    reasons: List[str] = []
    fallback_used = "none"
    if not model_available:
        reasons.append("The ML model is not currently available.")
        fallback_used = "baseline"
    if history_days < TIER_THRESHOLDS[2]:
        reasons.append(TIER_DESCRIPTIONS[TIER_COLD if tier == TIER_COLD else TIER_SHORT])
        fallback_used = "baseline"
    elif history_days < TIER_THRESHOLDS[3] and eligible:
        reasons.append(TIER_DESCRIPTIONS[TIER_LIMITED])
        # ML is permitted in this tier; the separate confidence label and
        # warning carry the limitation, so the execution label must not claim
        # that a baseline was used.
        fallback_used = "ml"
    elif eligible:
        fallback_used = "ml"
        reasons.append(TIER_DESCRIPTIONS[tier])

    return EligibilityDecision(
        eligible=eligible,
        tier=tier,
        tier_label=TIER_LABELS[tier],
        description=TIER_DESCRIPTIONS[tier],
        reasons=reasons,
        fallback_used=fallback_used,
        model_version=MODEL_VERSION if (model_available and eligible) else None,
        confidence_label=(
            "limited" if (eligible and history_days < TIER_THRESHOLDS[3])
            else "standard" if eligible
            else "insufficient_history" if history_days < TIER_THRESHOLDS[2]
            else "fallback"
        ),
    )


# ---------------------------------------------------------------------------
# Decision model
# ---------------------------------------------------------------------------

@dataclass
class EligibilityDecision:
    """Machine-readable + human-readable eligibility outcome.

    Fields:
        eligible        True when an ML forecast may be produced.
        tier            One of the TIER_* constants.
        tier_label      Friendly label ("Short history").
        description     Friendly multi-line copy (already user-facing).
        reasons         Bullet reasons for the decision.
        fallback_used   "ml" | "baseline" | "none"
        model_version   Model version string when a model produced the result.
        confidence_label "standard" | "limited" | "insufficient_history"
        gates           Auditable pass/fail records for every eligibility gate.
    """

    eligible: bool
    tier: str
    tier_label: str
    description: str
    reasons: List[str] = field(default_factory=list)
    fallback_used: str = "none"
    model_version: Optional[str] = None
    confidence_label: str = "insufficient_history"
    gates: List["DataGate"] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "eligible": self.eligible,
            "tier": self.tier,
            "tier_label": self.tier_label,
            "description": self.description,
            "reasons": self.reasons,
            "fallback_used": self.fallback_used,
            "model_version": self.model_version,
            "confidence_label": self.confidence_label,
            "gates": [gate.to_dict() for gate in self.gates],
        }


# ---------------------------------------------------------------------------
# Composite eligibility gate (spec §42 → §43)
# ---------------------------------------------------------------------------

@dataclass
class DataGate:
    """One gate in the eligibility pipeline. A gate failing = safe fallback."""

    name: str
    passed: bool
    reason: str = ""

    def to_dict(self) -> dict:
        return {"name": self.name, "passed": self.passed, "reason": self.reason}


# The gates run in this order (short-circuit on first hard failure).
GATE_REQUIRED_FIELDS = "required_fields"
GATE_TYPES = "data_types"
GATE_HISTORY = "sufficient_history"
GATE_QUALITY = "data_quality"
GATE_FEATURE_RANGE = "feature_ranges"
GATE_MODEL_COMPAT = "model_compatible"
GATE_CATEGORY = "known_categories"
GATE_MODEL_VERSION = "model_version"


class ModelEligibilityCheck:
    """Composite eligibility check for one product line of history.

    Mirrors spec §42 — Required fields → Data types → Enough history → Acceptable
    data quality → Features within expected ranges → Compatible model. Any hard
    failure makes ML ineligible and the caller must use the safe fallback
    (baseline), labeled, never silently.
    """

    def __init__(self, *, model_available: bool, model_features: List[str],
                 known_categories: Optional[set] = None,
                 today: Optional[date] = None,
                 model_version: str = MODEL_VERSION,
                 expected_model_version: str = MODEL_VERSION):
        self.model_available = model_available
        self.model_features = set(model_features or [])
        self._known_categories_provided = known_categories is not None
        self.known_categories = {
            str(category).strip().casefold()
            for category in (known_categories or set())
            if str(category).strip()
            and str(category).strip().casefold() not in {"unknown", "uncategorized"}
        }
        self.today = today or date.today()
        self.model_version = model_version
        self.expected_model_version = expected_model_version

    def evaluate(
        self,
        *,
        history_days: int,
        required_fields_present: bool = True,
        numeric_types_ok: bool = True,
        had_error_problems: int = 0,
        category_known: bool = True,
        feature_values_in_range: bool = True,
        feature_gap: List[str] | None = None,
    ) -> EligibilityDecision:
        """Run the full eligibility pipeline for a single product.

        The caller supplies pre-computed data-quality signals. Most are derived
        from the validation report + ingestion store; defaults (True/0) are the
        *ideal* case so callers only pass what they computed.
        """
        gates: List[DataGate] = []
        reasons: List[str] = []

        # 1 — Required fields present
        passed = required_fields_present
        gates.append(DataGate(GATE_REQUIRED_FIELDS, passed,
                              "" if passed else "Required fields are missing."))
        if not passed:
            reasons.append("Required fields are missing, so ML cannot run. "
                           "A baseline is used instead.")

        # 2 — Data types valid
        passed = numeric_types_ok
        gates.append(DataGate(GATE_TYPES, passed,
                              "" if passed else "One or more values have the wrong type."))
        if not passed:
            reasons.append("Data type problems exist; ML is not trusted on them.")

        # 3 — Enough history (§15/§16/§17)
        tier = classify_tier(history_days)
        enough = history_days >= TIER_THRESHOLDS[2]  # 90+
        gates.append(DataGate(GATE_HISTORY, enough,
                              TIER_DESCRIPTIONS[tier]))
        if not enough:
            reasons.append(TIER_DESCRIPTIONS[tier])

        # 4 — Data quality (validation errors)
        passed = had_error_problems == 0
        gates.append(DataGate(GATE_QUALITY, passed,
                              "" if passed else
                              f"{had_error_problems} blocking validation problem(s)."))
        if not passed:
            reasons.append("Blocking validation problems were found; nothing is "
                           "imported until they are resolved.")

        # 5 — Category labels must be known; the system never invents a label.
        # Treat an explicitly supplied placeholder-only universe as unknown as
        # well. An explicitly supplied empty or placeholder-only universe is
        # not a valid category baseline; when no universe is supplied, the
        # caller-provided category signal remains authoritative.
        known_category_values = set(self.known_categories)
        if self._known_categories_provided and not known_category_values:
            category_known = False
        passed = category_known
        gates.append(DataGate(
            GATE_CATEGORY,
            passed,
            "" if passed else "One or more category labels are unknown.",
        ))
        if not passed:
            reasons.append("An unknown category needs an explicit mapping before "
                           "ML can use it.")

        # 6 — Feature ranges
        passed = feature_values_in_range
        if feature_gap:
            passed = passed and not feature_gap
        feature_reason = ""
        if not passed:
            if feature_gap:
                feature_reason = (
                    "Required model features are missing or outside their "
                    "training ranges: " + ", ".join(str(item) for item in feature_gap)
                )
            else:
                feature_reason = (
                    "Feature values are outside the ranges the model was "
                    "trained on."
                )
        gates.append(DataGate(GATE_FEATURE_RANGE, passed, feature_reason))
        if not passed:
            reasons.append(
                feature_reason + " The result is not presented as high-confidence."
            )

        # 6 — Model compatible / available
        passed = self.model_available
        gates.append(DataGate(GATE_MODEL_COMPAT, passed,
                              "" if passed else "Forecast model is not available."))
        if not passed:
            reasons.append("The forecast model is temporarily unavailable. Your "
                           "data is safe; a baseline estimate is shown. Please "
                           "try again later.")

        # 8 — Version compatibility is a separate, auditable gate.
        version_ok = bool(self.model_version) and self.model_version == self.expected_model_version
        gates.append(DataGate(
            GATE_MODEL_VERSION,
            version_ok,
            "" if version_ok else "Forecast model version is missing or incompatible.",
        ))
        if not version_ok:
            reasons.append("The installed forecast model version is not the "
                           "approved version; a labeled baseline is used instead.")

        # -- final decision: any gate hard-failure → not eligible ------------
        eligible = all(g.passed for g in gates)
        if eligible:
            # The decision is about whether ML may run, not whether a policy
            # label should masquerade as the execution that actually happened.
            # Limited-history confidence is represented separately.
            fallback_used = "ml"
            confidence = (
                "limited" if history_days < TIER_THRESHOLDS[3] else "standard"
            )
        else:
            fallback_used = "baseline"
            confidence = (
                "insufficient_history"
                if history_days < TIER_THRESHOLDS[2]
                else "fallback"
            )
            # If the model is fine but history < 90, we still call it baseline
            # (the ML never ran for cold-start — there is nothing to show).
            if self.model_available and history_days < TIER_THRESHOLDS[2]:
                fallback_used = "baseline"

        decision = EligibilityDecision(
            eligible=eligible,
            tier=tier,
            tier_label=TIER_LABELS[tier],
            description=TIER_DESCRIPTIONS[tier],
            reasons=reasons,
            fallback_used=fallback_used,
            model_version=self.model_version if eligible else None,
            confidence_label=confidence,
        )
        # Attach gates for auditability.
        decision.gates = gates
        return decision
