"""Named inventory-policy profiles for the historical simulator.

The simulator answers "what would this replenishment policy have done over my
recorded history?". To answer that honestly it has to run the *same*
replenishment architecture the production recommendation does — only the
parameters change. That is all this module does: it maps a short policy key
(``current`` / ``conservative`` / ``aggressive`` / ``custom``) onto the
effective safety stock and the effective coverage demand for a day, and then
reuses the existing helpers to turn those into a reorder point and an
order-up-to level.

The architecture being parameterised, unchanged, is the one in
:class:`src.inventory.reorder` and :mod:`src.inventory.policy`::

    30-day demand forecast
        -> lead-time demand + safety stock   (reorder point)
        -> current stock + open orders      (inventory position)
        -> recommended order quantity

``current`` is the load-bearing profile: its multipliers are ``1.0`` and its
coverage is the supplier lead time, which reproduces
:meth:`backend.tenant.TenantWorkspace.reorder_recommendation` exactly. A
simulation run under ``current`` is therefore a faithful replay of what
EcomAI-OS would actually have done on the same days.

The other profiles differ only in their safety-stock multiplier. A bigger
buffer raises both the reorder point (so the order is triggered earlier and
the top-up is larger) and the order-up-to level, which is what "keep more
inventory" means in practice; a smaller buffer does the reverse. There is no
other invented formula here — the multipliers are declared in the table
below, are pure constants, and are unit-testable.

``custom`` replaces the multiplier with two values the server really applies:
an absolute ``safety_stock`` in units, and ``coverage_days`` — the number of
days of forecast demand the order must cover, which replaces the lead-time
demand in both the reorder point and the order-up-to target. Those are the
only two knobs a custom policy may set, because they are the only two the
server honours. Anything omitted falls back to the ``current`` profile's own
value rather than to a guess.

The ``description`` on each profile is shown to someone who has never seen
inventory simulation before, so it says what the strategy *does* rather than
which multiplier produces it. The multipliers stay visible in
:data:`POLICY_PROFILES` for anyone reading the code or the results payload, and
the results panel reports the effective numbers each run actually used, so the
plain wording costs no precision.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple

from src.inventory.policy import calculate_target_inventory
from src.inventory.reorder import calculate_reorder_point

# Multipliers on the policy-derived safety stock. Declared once, applied once,
# and reported back to the caller so a results panel can show what was actually
# simulated rather than what was asked for.
CONSERVATIVE_SAFETY_MULTIPLIER = 1.5
AGGRESSIVE_SAFETY_MULTIPLIER = 0.5


@dataclass(frozen=True)
class PolicyProfile:
    """A named, deterministic set of replenishment parameters.

    ``safety_multiplier`` scales the safety stock the inventory configuration
    derived for this product. ``coverage_multiplier`` scales the lead-time
    demand that the reorder point and the order-up-to target are built from;
    ``1.0`` means "cover exactly the supplier lead time", which is the
    production rule.
    """

    key: str
    label: str
    description: str
    safety_multiplier: float = 1.0
    coverage_multiplier: float = 1.0
    accepts_custom: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "description": self.description,
            "safety_multiplier": self.safety_multiplier,
            "coverage_multiplier": self.coverage_multiplier,
            "accepts_custom": self.accepts_custom,
        }


POLICY_PROFILES: Dict[str, PolicyProfile] = {
    "current": PolicyProfile(
        key="current",
        label="Current Policy",
        description="Uses the standard EcomAI-OS replenishment rules.",
    ),
    "conservative": PolicyProfile(
        key="conservative",
        label="Conservative",
        description="Keeps a larger safety buffer to reduce stockout risk.",
        safety_multiplier=CONSERVATIVE_SAFETY_MULTIPLIER,
    ),
    "aggressive": PolicyProfile(
        key="aggressive",
        label="Aggressive",
        description="Uses a smaller safety buffer to keep inventory lean.",
        safety_multiplier=AGGRESSIVE_SAFETY_MULTIPLIER,
    ),
    "custom": PolicyProfile(
        key="custom",
        label="Custom",
        description="Uses your selected safety parameters.",
        accepts_custom=True,
    ),
}

#: The policies the simulator compares against one another, in the order the
#: results table lists them. ``custom`` is excluded because its parameters are
#: chosen per run and are not a fixed column in that table.
COMPARABLE_POLICY_KEYS: Tuple[str, ...] = ("current", "conservative", "aggressive")

#: The only two parameters a custom policy may set. The UI is expected to offer
#: exactly these and nothing else.
CUSTOM_PARAM_FIELDS: Tuple[str, ...] = ("safety_stock", "coverage_days")


@dataclass(frozen=True)
class ResolvedPolicy:
    """The effective replenishment parameters for one simulated day.

    ``safety_stock``, ``coverage_demand``, ``reorder_point`` and
    ``order_up_to`` are what the engine actually used. They are returned so a
    results panel can print the real numbers instead of re-deriving them.
    """

    key: str
    label: str
    description: str
    safety_stock: float
    coverage_demand: float
    coverage_days: float
    lead_time_days: int
    reorder_point: float
    order_up_to: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "description": self.description,
            "safety_stock": round(self.safety_stock, 2),
            "coverage_demand": round(self.coverage_demand, 2),
            "coverage_days": round(self.coverage_days, 2),
            "lead_time_days": int(self.lead_time_days),
            "reorder_point": round(self.reorder_point, 2),
            "order_up_to": round(self.order_up_to, 2),
        }


def policy_keys() -> Tuple[str, ...]:
    """Every policy key the server accepts, in display order."""

    return ("current", "conservative", "aggressive", "custom")


def get_profile(key: Optional[str]) -> PolicyProfile:
    """Look up a profile by key, defaulting to ``current`` for no key.

    An *unrecognised* key is refused rather than silently treated as
    ``current``, so a typo cannot masquerade as the production policy.
    """

    normalised = (key or "current").strip().lower()
    if normalised not in POLICY_PROFILES:
        raise ValueError(
            f"'{key}' is not a supported inventory policy. Choose one of: "
            + ", ".join(policy_keys())
            + "."
        )
    return POLICY_PROFILES[normalised]


def _coerce_non_negative(value: Any, field: str) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(
            f"'{field}' must be a number, but {value!r} was supplied."
        ) from None
    if math.isnan(number) or math.isinf(number) or number < 0:
        raise ValueError(
            f"'{field}' must be zero or more, but {value!r} was supplied."
        )
    return number


def _coerce_positive(value: Any, field: str) -> Optional[float]:
    number = _coerce_non_negative(value, field)
    if number is None:
        return None
    if number <= 0:
        raise ValueError(f"'{field}' must be greater than zero.")
    return number


def resolve_policy(
    profile: PolicyProfile,
    *,
    safety_stock: float,
    daily_forecast: float,
    lead_time_demand: float,
    lead_time_days: int,
    custom: Optional[Mapping[str, Any]] = None,
) -> ResolvedPolicy:
    """Resolve a profile into the effective parameters for one day.

    Parameters
    ----------
    profile:
        The named profile to apply.
    safety_stock:
        The safety stock the inventory configuration derived for this product
        under the standard rules. Scaled by the profile, or replaced outright
        when a custom policy sets it.
    daily_forecast:
        One day of forecast demand. Only a custom ``coverage_days`` reads it.
    lead_time_demand:
        Forecast demand across the supplier lead time — the demand the
        replenishment target covers unless a custom policy says otherwise.
    lead_time_days:
        The product's supplier lead time, kept on the result for display.
    custom:
        ``{"safety_stock": units, "coverage_days": days}`` for the custom
        profile. Unknown keys are rejected, and a non-custom profile rejects
        them outright, so a field the server would ignore cannot look like it
        is being applied.

    Returns
    -------
    ResolvedPolicy
    """

    base_safety = max(float(safety_stock or 0.0), 0.0)
    base_coverage = max(float(lead_time_demand or 0.0), 0.0)

    supplied = dict(custom or {})

    if not profile.accepts_custom:
        # A preset is a fixed set of parameters. Accepting custom values here
        # and then ignoring them would let the UI show a number the run never
        # used, so they are refused instead.
        if supplied:
            raise ValueError(
                f"'{profile.key}' is a fixed policy and takes no custom "
                "parameters. Choose the custom policy to set "
                + " and ".join(CUSTOM_PARAM_FIELDS)
                + "."
            )
        # A preset scales the configured safety stock. The scale factor is a
        # declared constant and the result is rounded up to whole units,
        # because safety stock is a quantity of stock.
        effective_safety = math.ceil(base_safety * profile.safety_multiplier)
        coverage_demand = base_coverage * profile.coverage_multiplier
        coverage_days = float(lead_time_days) * profile.coverage_multiplier
    else:
        unknown = sorted(set(supplied) - set(CUSTOM_PARAM_FIELDS))
        if unknown:
            raise ValueError(
                "A custom policy accepts only "
                + " and ".join(CUSTOM_PARAM_FIELDS)
                + f", but {', '.join(unknown)} was supplied."
            )
        custom_safety = _coerce_non_negative(supplied.get("safety_stock"), "safety_stock")
        custom_coverage = _coerce_positive(supplied.get("coverage_days"), "coverage_days")

        effective_safety = base_safety if custom_safety is None else custom_safety
        if custom_coverage is None:
            coverage_demand = base_coverage
            coverage_days = float(lead_time_days)
        else:
            coverage_days = custom_coverage
            coverage_demand = max(float(daily_forecast or 0.0), 0.0) * coverage_days

    effective_safety = max(float(effective_safety), 0.0)

    # Both levels come from the same existing helpers the production reorder
    # recommendation uses, so the simulator and live V2 cannot drift apart.
    reorder_point = float(calculate_reorder_point(coverage_demand, effective_safety))
    order_up_to = float(calculate_target_inventory(coverage_demand, effective_safety))

    return ResolvedPolicy(
        key=profile.key,
        label=profile.label,
        description=profile.description,
        safety_stock=effective_safety,
        coverage_demand=float(coverage_demand),
        coverage_days=float(coverage_days),
        lead_time_days=int(lead_time_days),
        reorder_point=reorder_point,
        order_up_to=order_up_to,
    )


def describe_profiles() -> Iterable[Dict[str, Any]]:
    """Every profile as plain data, for the UI to render from."""

    return [POLICY_PROFILES[key].to_dict() for key in policy_keys()]


def describe_custom_fields() -> Dict[str, str]:
    """What each accepted custom parameter means, for the UI to show."""

    return {
        "safety_stock": (
            "Extra stock kept on hand as a buffer against forecast error. A "
            "higher buffer reorders earlier and in larger lots."
        ),
        "coverage_days": (
            "Days of forecast demand each purchase order must cover. The "
            "default equals the supplier lead time."
        ),
    }
