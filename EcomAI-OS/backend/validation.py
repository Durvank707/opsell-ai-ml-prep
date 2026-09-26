"""Row-level validation engine for EcomAI-OS uploads.

Consumes the canonical contracts (``backend.contracts``) and applies the
spec's data-quality rules at *row* granularity so problems are never vague:

    * missing required field          → row rejected, error (never invented)
    * wrong type                      → row rejected, error
    * invalid / ambiguous date        → error/warn with explicit resolution
    * duplicate business key          → warn, dedupe offered (never double-count)
    * negative units / zero units     → warn/error, explicit returns policy
    * unknown category                → warn, mapping offered (never guessed)
    * value out of canonical range    → error/warn

Every problem carries: category, severity, row number, raw value, friendly
detail, and a concrete resolution. Nothing is ever quietly dropped,
estimated, or "cleaned" — the contract decides, and the report says so.

Severity semantics (spec-safe, not stack-trace copy):
    SEV_ERROR  → blocks import for that row; the row is NOT accepted.
    SEV_WARN   → row is accepted but visibly labeled.
    SEV_INFO   → informational only (e.g. a zero units is valid, noted).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import json
import math
import re
from typing import Any, Dict, List, Optional, Sequence

from backend.contracts import (
    FieldContract,
    RecordContract,
    ValidationProblemCategories as Cat,
)

SEV_ERROR = "error"
SEV_WARN = "warn"
SEV_INFO = "info"


def _json_safe(value: Any) -> Any:
    """Make validation payloads safe for JSON/job transports without changing
    the canonical in-memory values used by persistence.
    """
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(item) for item in value]
    if isinstance(value, Decimal):
        return str(value) if value.is_finite() else repr(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, float) and not math.isfinite(value):
        return repr(value)
    return value


@dataclass
class RowProblem:
    category: str
    severity: str
    row_number: int
    field: Optional[str] = None
    raw_value: Optional[Any] = None
    detail: str = ""
    resolution: str = ""

    def to_dict(self) -> dict:
        return {
            "category": self.category,
            "severity": self.severity,
            "row_number": self.row_number,
            "field": self.field,
            "raw_value": _json_safe(self.raw_value),
            "detail": self.detail,
            "resolution": self.resolution,
        }


@dataclass
class ValidatedRow:
    """One canonicalized, accepted row (post-mapping, pre-store)."""

    values: Dict[str, Any]
    problems: List[RowProblem] = field(default_factory=list)

    @property
    def accepted(self) -> bool:
        return not any(p.severity == SEV_ERROR for p in self.problems)

    def to_dict(self) -> dict:
        return {
            "values": _json_safe(self.values),
            "accepted": self.accepted,
            "problems": [p.to_dict() for p in self.problems],
        }


@dataclass
class RowValidationResult:
    """Aggregate for one file pass."""

    total_rows: int = 0
    accepted_rows: int = 0
    rejected_rows: int = 0
    rows: List[ValidatedRow] = field(default_factory=list)
    problems: List[RowProblem] = field(default_factory=list)   # all (flat)
    schema_problems: List[RowProblem] = field(default_factory=list)

    @property
    def error_count(self) -> int:
        return sum(1 for p in self.problems if p.severity == SEV_ERROR)

    @property
    def warn_count(self) -> int:
        return sum(1 for p in self.problems if p.severity == SEV_WARN)

    def summary(self) -> str:
        if any(problem.severity == SEV_ERROR for problem in self.schema_problems):
            return ("The file has blocking schema problems; no rows were "
                    "treated as ready to import.")
        if not self.total_rows:
            return "The file contains no data rows and was not imported."
        if self.rejected_rows:
            return (f"{self.rejected_rows:,} of {self.total_rows:,} rows have "
                    f"blocking problems and were not imported.")
        if self.warn_count:
            return (f"{self.accepted_rows:,} rows validated with visible warnings; "
                    "review them before import.")
        return (f"{self.accepted_rows:,} rows validated and ready to import.")


# ---------------------------------------------------------------------------
# Coercion helpers (canonical types)
# ---------------------------------------------------------------------------

def _coerce_string(raw: Any) -> Optional[str]:
    if raw is None or isinstance(raw, (dict, list, tuple, set, bool)):
        return None
    if isinstance(raw, float) and not math.isfinite(raw):
        return None
    s = str(raw).strip()
    return s if s else None


def _coerce_int(raw: Any) -> Optional[int]:
    if raw is None or isinstance(raw, bool):
        return None
    s = str(raw).strip()
    if not s or "_" in s:
        return None
    if not re.fullmatch(
        r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", s
    ):
        return None
    try:
        # Decimal avoids silently rounding a large integer through a binary
        # float (for example 9007199254740993).
        value = Decimal(s)
    except (InvalidOperation, TypeError, ValueError, OverflowError):
        return None
    if not value.is_finite() or value != value.to_integral_value():
        return None
    return int(value)


def _coerce_float(raw: Any) -> Optional[float]:
    if raw is None:
        return None
    s = str(raw).strip()
    # Currency prefixes are unambiguous; comma handling is deliberately
    # strict so ``1,2`` is never silently turned into ``12``.
    s = re.sub(r"^[\u20b9$€£]\s*", "", s)
    if not s:
        return None
    if "," in s:
        if "." in s:
            if not re.fullmatch(r"[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?", s):
                return None
        elif not re.fullmatch(r"[+-]?\d{1,3}(?:,\d{3})+", s):
            return None
        s = s.replace(",", "")
    if not re.fullmatch(
        r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", s
    ):
        return None
    try:
        value = float(s)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _coerce_bool(raw: Any) -> Optional[bool]:
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if s in ("1", "true", "yes", "y", "on"):
        return True
    if s in ("0", "false", "no", "n", "off"):
        return False
    return None


def _json_is_finite(value: Any) -> bool:
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, dict):
        return all(_json_is_finite(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return all(_json_is_finite(item) for item in value)
    return True


def _coerce_json(raw: Any) -> Optional[Any]:
    """Accept JSON-native values without stringifying structured data."""
    if isinstance(raw, (dict, list)):
        return raw if _json_is_finite(raw) else None
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return None
        return parsed if _json_is_finite(parsed) else None
    if raw is None or isinstance(raw, (bool, int, float)):
        if isinstance(raw, float) and not math.isfinite(raw):
            return None
        return raw
    return None


def coerce_value(raw: Any, field_contract: FieldContract) -> Optional[Any]:
    """Coerce a raw cell to the canonical type; None on unrecognizable input.

    Callers treat None-from-a-required-field as a TypeError problem; they never
    silently keep the raw string.
    """
    dtype = field_contract.data_type
    if dtype == "string":
        return _coerce_string(raw)
    if dtype == "int":
        return _coerce_int(raw)
    if dtype == "float":
        return _coerce_float(raw)
    if dtype == "boolean":
        return _coerce_bool(raw)
    if dtype == "date":
        from backend.contracts import parse_date_iso
        if isinstance(raw, str):
            return parse_date_iso(raw)
        if isinstance(raw, datetime):
            return raw.date()
        if isinstance(raw, date):
            return raw
        return None
    if dtype == "json":
        return _coerce_json(raw)
    return _coerce_string(raw)   # unknown dtype → best-effort string


# ---------------------------------------------------------------------------
# Column mapping and file-level checks
# ---------------------------------------------------------------------------


def _header_key(value: Any) -> str:
    """Stable comparison key for a user column name.

    Treats spaces, hyphens, and punctuation as the same separator so common
    case/format variants (for example ``Product ID`` and ``product-id``) do
    not become unexplained missing columns.  Collisions are still surfaced as
    ambiguous mapping problems rather than guessed.
    """
    normalized = re.sub(r"[^a-z0-9]+", "_", str(value).strip().casefold())
    return normalized.strip("_")


def _row_headers(rows: Sequence[Dict[str, Any]], columns: Optional[Sequence[str]]) -> List[str]:
    if columns is not None:
        return [str(c) for c in columns]
    headers: List[str] = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in row.keys():
            marker = (type(key), str(key))
            if marker not in seen:
                headers.append(str(key))
                seen.add(marker)
    return headers


def _mapping_candidate(
    mapping: Dict[str, str], contract: RecordContract, headers: Sequence[str], direction: str
) -> tuple[bool, Dict[str, str], int]:
    """Resolve one possible mapping direction and score endpoint validity.

    A mapping can contain both canonical-looking and alias-looking endpoints.
    Scoring both orientations prevents a mixed raw→canonical map from being
    misread merely because one endpoint happens to be spelled ``date``.
    """
    canonical_by_key: Dict[str, str] = {
        _header_key(field.canonical_name): field.canonical_name
        for field in contract.fields
    }
    for field in contract.fields:
        for alias in field.aliases:
            canonical_by_key.setdefault(_header_key(alias), field.canonical_name)

    header_by_key = {_header_key(header): header for header in headers}
    resolved: Dict[str, str] = {}
    valid = True
    valid_pairs = 0
    for mapping_key, mapping_value in mapping.items():
        key = _header_key(mapping_key)
        value = _header_key(mapping_value)
        if direction == "canonical_to_raw":
            canonical = canonical_by_key.get(key)
            raw = header_by_key.get(value)
        else:
            raw = header_by_key.get(key)
            canonical = canonical_by_key.get(value)
        if canonical is None or raw is None:
            valid = False
            continue
        valid_pairs += 1
        prior = resolved.get(canonical)
        if prior is not None and _header_key(prior) != _header_key(raw):
            valid = False
            continue
        resolved[canonical] = raw
    return valid, resolved, valid_pairs


def _mapping_direction(
    mapping: Dict[str, str], contract: RecordContract, headers: Sequence[str]
) -> str:
    """Determine whether an explicit mapping is canonical→raw or raw→canonical.

    Both directions are supported.  We score the actual header/contract
    endpoints instead of relying on a single spelling heuristic; this is
    important for mixed maps where, for example, ``date`` is a raw header but
    ``sale_date`` is the canonical target.
    """
    if not mapping:
        return "canonical_to_raw"

    c2r_valid, c2r_resolved, c2r_score = _mapping_candidate(
        mapping, contract, headers, "canonical_to_raw"
    )
    r2c_valid, r2c_resolved, r2c_score = _mapping_candidate(
        mapping, contract, headers, "raw_to_canonical"
    )
    if c2r_score != r2c_score:
        return "canonical_to_raw" if c2r_score > r2c_score else "raw_to_canonical"
    if c2r_valid and not r2c_valid:
        return "canonical_to_raw"
    if r2c_valid and not c2r_valid:
        return "raw_to_canonical"

    header_keys = {_header_key(header) for header in headers}
    key_headers = sum(_header_key(key) in header_keys for key in mapping)
    value_headers = sum(_header_key(value) in header_keys for value in mapping.values())
    if value_headers > key_headers:
        return "canonical_to_raw"
    if key_headers > value_headers:
        return "raw_to_canonical"

    # Both forms are fully valid.  If they resolve to the same canonical→raw
    # mapping, the orientation is immaterial; otherwise the caller reports an
    # ambiguity rather than guessing.
    if c2r_valid and r2c_valid and c2r_resolved == r2c_resolved:
        return "canonical_to_raw"
    return "canonical_to_raw" if c2r_valid else "raw_to_canonical"


def _auto_mapping(
    contract: RecordContract, headers: Sequence[str]
) -> tuple[Dict[str, str], List[RowProblem]]:
    """Detect canonical columns and aliases without choosing ambiguously."""
    aliases: Dict[str, List[str]] = {}
    for field_contract in contract.fields:
        names = (field_contract.canonical_name,) + tuple(field_contract.aliases)
        aliases[_header_key(field_contract.canonical_name)] = [
            field_contract.canonical_name
        ]
        for alias in names:
            aliases.setdefault(_header_key(alias), []).append(field_contract.canonical_name)

    resolved: Dict[str, str] = {}
    problems: List[RowProblem] = []
    for header in headers:
        candidates = sorted(set(aliases.get(_header_key(header), [])))
        if len(candidates) == 1:
            canonical = candidates[0]
            previous = resolved.get(canonical)
            if previous is not None and previous != header:
                problems.append(RowProblem(
                    category=Cat.AMBIGUOUS_COLUMN,
                    severity=SEV_ERROR,
                    row_number=0,
                    field=canonical,
                    raw_value=[previous, header],
                    detail=(
                        f"Columns '{previous}' and '{header}' both map to "
                        f"'{canonical}'."
                    ),
                    resolution="Keep one unambiguous source column and map it "
                               "explicitly; no column was chosen automatically.",
                ))
            else:
                resolved[canonical] = header
        elif len(candidates) > 1:
            problems.append(RowProblem(
                category=Cat.AMBIGUOUS_COLUMN,
                severity=SEV_ERROR,
                row_number=0,
                field=header,
                raw_value=header,
                detail=(
                    f"Column '{header}' matches more than one canonical field: "
                    f"{', '.join(candidates)}."
                ),
                resolution="Rename the column or provide one explicit mapping; "
                           "the upload was not guessed.",
            ))
    return resolved, problems


def _resolve_mapping(
    rows: Sequence[Dict[str, Any]],
    contract: RecordContract,
    mapping: Dict[str, str],
    columns: Optional[Sequence[str]],
) -> tuple[Dict[str, str], List[str], List[RowProblem]]:
    """Resolve, detect, and explain every supplied column."""
    headers = _row_headers(rows, columns)
    header_set = {_header_key(header) for header in headers}
    duplicate_headers: List[RowProblem] = []
    seen_header_keys = set()
    for header in headers:
        marker = _header_key(header)
        if marker in seen_header_keys:
            duplicate_headers.append(RowProblem(
                category=Cat.AMBIGUOUS_COLUMN,
                severity=SEV_ERROR,
                row_number=0,
                field=header,
                raw_value=header,
                detail=f"Column '{header}' is declared more than once.",
                resolution="Rename or remove the duplicate column; it was not "
                           "resolved automatically.",
            ))
        seen_header_keys.add(marker)
    header_by_key = {_header_key(header): header for header in headers}
    explicit_problems: List[RowProblem] = []
    if mapping:
        direction = _mapping_direction(mapping, contract, headers)
        canonical_by_key = {
            _header_key(field.canonical_name): field.canonical_name
            for field in contract.fields
        }
        # Accept an alias as an explicit mapping target as well as the
        # canonical spelling.  The target is still resolved to one canonical
        # field; aliases are never treated as a second contract.
        for field in contract.fields:
            for alias in field.aliases:
                canonical_by_key.setdefault(_header_key(alias), field.canonical_name)

        c2r_valid, c2r_resolved, _ = _mapping_candidate(
            mapping, contract, headers, "canonical_to_raw"
        )
        r2c_valid, r2c_resolved, _ = _mapping_candidate(
            mapping, contract, headers, "raw_to_canonical"
        )
        if c2r_valid and r2c_valid and c2r_resolved != r2c_resolved:
            explicit_problems.append(RowProblem(
                category=Cat.AMBIGUOUS_COLUMN,
                severity=SEV_ERROR,
                row_number=0,
                field=None,
                raw_value=dict(mapping),
                detail=(
                    "The supplied mapping can be read in both canonical-to-raw "
                    "and raw-to-canonical directions with different results."
                ),
                resolution=(
                    "Use source columns on the left and canonical fields on the "
                    "right, or the reverse consistently; the ambiguous mapping "
                    "was rejected."
                ),
            ))

        if direction == "canonical_to_raw":
            resolved = {}
            used_raw: Dict[str, str] = {}
            for mapping_key, mapping_value in mapping.items():
                canonical = canonical_by_key.get(
                    _header_key(mapping_key), str(mapping_key)
                )
                raw = header_by_key.get(
                    _header_key(mapping_value), str(mapping_value)
                )
                prior = resolved.get(canonical)
                if prior is not None and _header_key(prior) != _header_key(raw):
                    explicit_problems.append(RowProblem(
                        category=Cat.AMBIGUOUS_COLUMN,
                        severity=SEV_ERROR,
                        row_number=0,
                        field=canonical,
                        raw_value=[prior, raw],
                        detail=(f"Canonical field '{canonical}' is mapped from "
                                f"both '{prior}' and '{raw}'."),
                        resolution="Choose one source column; the ambiguous mapping "
                                   "was rejected.",
                    ))
                    continue
                resolved[canonical] = raw
                raw_key = _header_key(raw)
                prior_source = used_raw.get(raw_key)
                if prior_source is not None and prior_source != canonical:
                    explicit_problems.append(RowProblem(
                        category=Cat.AMBIGUOUS_COLUMN,
                        severity=SEV_ERROR,
                        row_number=0,
                        field=raw,
                        raw_value=[prior_source, canonical],
                        detail=(f"Source column '{raw}' is mapped to both "
                                f"'{prior_source}' and '{canonical}'."),
                        resolution="Map each source column to one canonical field; "
                                   "the ambiguous mapping was rejected.",
                    ))
                used_raw[raw_key] = canonical
        else:
            resolved = {}
            used_canonical: Dict[str, str] = {}
            for raw, canonical_value in mapping.items():
                canonical = canonical_by_key.get(
                    _header_key(canonical_value), str(canonical_value)
                )
                prior = used_canonical.get(canonical)
                raw_header = header_by_key.get(_header_key(raw), str(raw))
                if prior is not None and _header_key(prior) != _header_key(raw_header):
                    explicit_problems.append(RowProblem(
                        category=Cat.AMBIGUOUS_COLUMN,
                        severity=SEV_ERROR,
                        row_number=0,
                        field=canonical,
                        raw_value=[prior, raw_header],
                        detail=(f"Canonical field '{canonical}' is mapped from "
                                f"both '{prior}' and '{raw_header}'."),
                        resolution="Choose one source column; the ambiguous mapping "
                                   "was rejected.",
                    ))
                    continue
                used_canonical[canonical] = raw_header
                resolved[canonical] = raw_header
    else:
        resolved, auto_problems = _auto_mapping(contract, headers)
        problems = list(auto_problems) + duplicate_headers

    if not mapping:
        # The auto path still reports unknown and required columns; detection
        # is not permission to silently discard or guess them.
        mapped_raw = {_header_key(raw) for raw in resolved.values()}
        for header in headers:
            if _header_key(header) not in mapped_raw:
                problems.append(RowProblem(
                    category=Cat.EXTRA_COLUMN,
                    severity=SEV_WARN,
                    row_number=0,
                    field=header,
                    raw_value=header,
                    detail=(
                        f"Column '{header}' is not a known canonical column and "
                        f"was not stored."
                    ),
                    resolution="Map the column explicitly or remove it before "
                               "re-uploading.",
                ))
        for field_contract in contract.fields:
            if field_contract.required and field_contract.canonical_name not in resolved:
                problems.append(RowProblem(
                    category=Cat.MISSING_COLUMN,
                    severity=SEV_ERROR,
                    row_number=0,
                    field=field_contract.canonical_name,
                    detail=(
                        f"Required column '{field_contract.canonical_name}' is missing."
                    ),
                    resolution="Add the required column or provide an explicit mapping; "
                               "missing values are never estimated.",
                ))
        return resolved, headers, problems

    problems: List[RowProblem] = list(duplicate_headers) + explicit_problems
    canonical_names = {f.canonical_name for f in contract.fields}
    for canonical, raw in resolved.items():
        if canonical not in canonical_names:
            problems.append(RowProblem(
                category=Cat.MISSING_COLUMN,
                severity=SEV_ERROR,
                row_number=0,
                field=canonical,
                raw_value=raw,
                detail=f"Mapping target '{canonical}' is not a field in the "
                       f"{contract.record_type!r} contract.",
                resolution="Map the upload to a canonical field defined by the "
                           "contract.",
            ))
        if _header_key(raw) not in header_set:
            problems.append(RowProblem(
                category=Cat.MISSING_COLUMN,
                severity=SEV_ERROR,
                row_number=0,
                field=canonical,
                raw_value=raw,
                detail=f"Mapped source column '{raw}' is not present in the upload.",
                resolution="Correct the mapping or include the source column; "
                           "no replacement column is assumed.",
            ))

    mapped_raw = {_header_key(raw) for raw in resolved.values()}
    for header in headers:
        if _header_key(header) not in mapped_raw:
            problems.append(RowProblem(
                category=Cat.EXTRA_COLUMN,
                severity=SEV_WARN,
                row_number=0,
                field=header,
                raw_value=header,
                detail=f"Column '{header}' is not mapped to the "
                       f"{contract.record_type!r} contract and was not stored.",
                resolution="Map the column explicitly or remove it before "
                           "re-uploading.",
            ))

    for field_contract in contract.fields:
        if field_contract.required and field_contract.canonical_name not in resolved:
            problems.append(RowProblem(
                category=Cat.MISSING_COLUMN,
                severity=SEV_ERROR,
                row_number=0,
                field=field_contract.canonical_name,
                detail=(
                    f"Required column '{field_contract.canonical_name}' is missing."
                ),
                resolution="Add the required column or provide an explicit mapping; "
                           "missing values are never estimated.",
            ))
    return resolved, headers, problems


def _schema_row_problems(
    schema_problems: Sequence[RowProblem], row_number: int
) -> List[RowProblem]:
    """Copy file-level blockers onto a concrete row for count consistency."""
    copied: List[RowProblem] = []
    for problem in schema_problems:
        if problem.severity != SEV_ERROR:
            continue
        copied.append(RowProblem(
            category=problem.category,
            severity=problem.severity,
            row_number=row_number,
            field=problem.field,
            raw_value=problem.raw_value,
            detail=problem.detail,
            resolution=problem.resolution,
        ))
    return copied


# ---------------------------------------------------------------------------
# Row validation
# ---------------------------------------------------------------------------

def validate_row(
    row: Dict[str, Any],
    contract: RecordContract,
    *,
    row_number: int,
    mapping: Dict[str, str],          # canonical → raw header
    known_categories: Optional[set] = None,
    schema_problems: Optional[Sequence[RowProblem]] = None,
    category_universe_provided: Optional[bool] = None,
) -> ValidatedRow:
    """Validate one mapped row against the canonical contract.

    ``mapping`` is resolved to canonical→raw before this function runs. Values
    that failed coercion are still reported with the raw value; the system
    never silently coerces a bad cell into a guess.
    """
    problems: List[RowProblem] = []
    if category_universe_provided is None:
        category_universe_provided = known_categories is not None
    known_category_keys = {
        str(category).strip().casefold()
        for category in (known_categories or set())
        if str(category).strip()
    }
    # ``Unknown`` and ``Uncategorized`` are placeholders, not a real category
    # universe. An explicitly supplied empty/placeholder-only universe must
    # still make a present category visibly unknown rather than silently
    # bypassing the category gate.
    known_category_keys = {
        category for category in known_category_keys
        if category not in {"unknown", "uncategorized"}
    }
    if not isinstance(row, dict):
        return ValidatedRow(
            values={},
            problems=[RowProblem(
                category=Cat.DATA_TYPE,
                severity=SEV_ERROR,
                row_number=row_number,
                raw_value=row,
                detail=f"Row {row_number} is not a mapping/object.",
                resolution="Upload one JSON object per row with the declared columns.",
            )],
        )
    if schema_problems:
        problems.extend(_schema_row_problems(schema_problems, row_number))

    for fc in contract.fields:
        raw_header = mapping.get(fc.canonical_name)
        if raw_header is None:
            if fc.required:
                problems.append(RowProblem(
                    category=Cat.MISSING_REQUIRED,
                    severity=SEV_ERROR,
                    row_number=row_number,
                    field=fc.canonical_name,
                    detail=(
                        f"Required field '{fc.canonical_name}' has no mapped "
                        f"column in row {row_number}."
                    ),
                    resolution="Add the column or provide an explicit mapping; "
                               "a missing value is never estimated.",
                ))
            elif fc.missing_behaviour in {"flag", "fallback_unknown"}:
                problems.append(RowProblem(
                    category=Cat.MISSING_VALUE,
                    severity=SEV_WARN,
                    row_number=row_number,
                    field=fc.canonical_name,
                    detail=(
                        f"Optional field '{fc.canonical_name}' is not mapped "
                        f"in row {row_number}."
                    ),
                    resolution="The row is kept with this field labeled missing; "
                               "map it when the source value is available.",
                ))
            continue
        if raw_header not in row:
            problems.append(RowProblem(
                category=Cat.MISSING_REQUIRED if fc.required else Cat.MISSING_VALUE,
                severity=SEV_ERROR if fc.required else SEV_WARN,
                row_number=row_number,
                field=fc.canonical_name,
                detail=(
                    f"Mapped column '{raw_header}' is absent from row {row_number}."
                ),
                resolution="Include the mapped column in every row; no value "
                           "is substituted.",
            ))
            continue
        raw_value = row.get(raw_header)

        # -- presence -------------------------------------------------------
        present = raw_value is not None and str(raw_value).strip() != ""
        if not present:
            if fc.required:
                problems.append(RowProblem(
                    category=Cat.MISSING_REQUIRED, severity=SEV_ERROR,
                    row_number=row_number, field=fc.canonical_name, raw_value=raw_value,
                    detail=(f"Required field '{fc.canonical_name}' is missing "
                            f"in row {row_number}."),
                    resolution="Fill the value and re-upload; a missing required "
                               "field is never estimated.",
                ))
            elif fc.missing_behaviour in {"flag", "fallback_unknown"}:
                problems.append(RowProblem(
                    category=Cat.MISSING_VALUE, severity=SEV_WARN,
                    row_number=row_number, field=fc.canonical_name, raw_value=None,
                    detail=(f"Optional field '{fc.canonical_name}' is missing in "
                            f"row {row_number}."),
                    resolution="Optional; the row is accepted but the field is "
                               "labeled missing and no value is guessed.",
                ))
            continue

        # -- coercion -------------------------------------------------------
        coerced = coerce_value(raw_value, fc)
        fail_type = coerced is None
        if not fail_type and fc.data_type in ("int", "float"):
            # numeric range check (only when we have a number and a bound)
            for bound, op, label in ((fc.min, "<", "minimum"), (fc.max, ">", "maximum")):
                if bound is not None and (coerced < bound if op == "<" else coerced > bound):
                    problems.append(RowProblem(
                        category=Cat.RANGE if op == ">" else Cat.RANGE, severity=SEV_ERROR,
                        row_number=row_number, field=fc.canonical_name, raw_value=raw_value,
                        detail=(f"Row {row_number}: '{fc.canonical_name}'={raw_value} "
                                f"is {op} the allowed {label} ({bound})."),
                        resolution="Correct the value or remove the row.",
                    ))
        if fail_type:
            problems.append(RowProblem(
                category=Cat.DATA_TYPE, severity=SEV_ERROR,
                row_number=row_number, field=fc.canonical_name, raw_value=raw_value,
                detail=(f"Row {row_number}: '{fc.canonical_name}'='{raw_value}' is "
                        f"not a valid {fc.data_type}."),
                resolution=(f"Expected {fc.data_type}; correct the cell and "
                            "re-upload."),
            ))
            continue

        # -- business semantics (never silent) --------------------------------
        if fc.canonical_name in ("units_sold", "units", "units_sold") and fc.data_type in ("int", "float"):
            if coerced is not None and coerced < 0:
                problems.append(RowProblem(
                    category=Cat.NEGATIVE_UNITS, severity=SEV_WARN,
                    row_number=row_number, field=fc.canonical_name, raw_value=raw_value,
                    detail=(f"Row {row_number}: negative units ({coerced}). A "
                            f"negative value is NOT normal demand."),
                    resolution=("If this is a return or refund, use the Returns "
                                "channel instead of negative sales."),
                ))
            elif coerced is not None and coerced == 0:
                problems.append(RowProblem(
                    category=Cat.ZERO_UNITS, severity=SEV_INFO,
                    row_number=row_number, field=fc.canonical_name, raw_value=raw_value,
                    detail=(f"Row {row_number}: 0 units. Genuine zero demand is "
                            "valid data, not a missing value."),
                    resolution="No action; kept as a real observation.",
                ))

        if fc.canonical_name == "category" and category_universe_provided:
            cat_val = coerced if isinstance(coerced, str) else None
            if cat_val and cat_val.casefold() not in known_category_keys:
                problems.append(RowProblem(
                    category=Cat.UNKNOWN_CATEGORY, severity=SEV_WARN,
                    row_number=row_number, field=fc.canonical_name, raw_value=raw_value,
                    detail=(f"Row {row_number}: category '{cat_val}' is not one of "
                            f"the known categories."),
                    resolution="Map it to a known category or add it explicitly; "
                               "never guessed.",
                ))

    return ValidatedRow(values=_accepted_values(row, contract, mapping, problems),
                        problems=problems)


def _accepted_values(row, contract, mapping, problems) -> Dict[str, Any]:
    """Build canonical values dict from accepted cells only."""
    values: Dict[str, Any] = {}
    for fc in contract.fields:
        raw_header = mapping.get(fc.canonical_name)
        if raw_header is None or raw_header not in row:
            continue
        coerced = coerce_value(row[raw_header], fc)
        if coerced is None:
            continue
        values[fc.canonical_name] = coerced
    return values


# ---------------------------------------------------------------------------
# Whole-file runner
# ---------------------------------------------------------------------------

def validate_rows(
    rows: Sequence[Dict[str, Any]],
    contract: RecordContract,
    *,
    mapping: Optional[Dict[str, str]] = None,
    columns: Optional[Sequence[str]] = None,
    known_categories: Optional[set] = None,
    max_rows: Optional[int] = None,
) -> RowValidationResult:
    """Validate a file and return accepted rows plus every visible problem.

    Mapping is resolved once, aliases are detected, unknown columns are
    reported, and business-key duplicates are labeled rather than silently
    discarded.  ``max_rows`` is a hard file gate: an oversized file is
    reported and none of its rows is accepted for import.
    """
    if rows is None:
        rows = []
    elif isinstance(rows, dict):
        rows = [rows]
    elif isinstance(rows, (str, bytes)):
        rows = [rows]
    else:
        try:
            rows = list(rows)
        except TypeError:
            rows = [rows]
    known_category_keys = {
        str(category).strip().casefold()
        for category in (known_categories or set())
        if str(category).strip()
    }
    category_universe_provided = known_categories is not None
    result = RowValidationResult(total_rows=len(rows))
    resolved_mapping, _headers, schema_problems = _resolve_mapping(
        rows, contract, mapping or {}, columns
    )

    if not rows:
        schema_problems.append(RowProblem(
            category=Cat.EMPTY_FILE,
            severity=SEV_ERROR,
            row_number=0,
            detail="The upload contains no data rows.",
            resolution="Upload at least one row; an empty file was not treated "
                       "as a successful import.",
        ))
    if max_rows is not None and len(rows) > max_rows:
        schema_problems.append(RowProblem(
            category=Cat.OVERSIZED_FILE,
            severity=SEV_ERROR,
            row_number=0,
            raw_value=len(rows),
            detail=(f"The upload has {len(rows)} rows; the configured limit is "
                    f"{max_rows}."),
            resolution="Split the file into smaller, valid uploads before retrying.",
        ))

    result.schema_problems = schema_problems
    result.problems.extend(schema_problems)

    # A file-level blocker invalidates every row.  We still validate each row
    # below so the caller receives precise row diagnostics rather than a
    # silently truncated list.
    seen_keys: Dict[tuple, int] = {}
    for i, row in enumerate(rows, start=1):
        vr = validate_row(
            row,
            contract,
            row_number=i,
            mapping=resolved_mapping,
            known_categories=known_category_keys,
            schema_problems=schema_problems,
            category_universe_provided=category_universe_provided,
        )

        # Duplicate business keys are a warning, never an implicit overwrite.
        if isinstance(row, dict) and contract.business_key:
            try:
                key_values = tuple(
                    coerce_value(
                        row.get(resolved_mapping.get(key, key)),
                        contract.field(key),
                    )
                    if contract.field(key) is not None
                    else row.get(resolved_mapping.get(key, key))
                    for key in contract.business_key
                )
                if all(value is not None for value in key_values):
                    if key_values in seen_keys:
                        vr.problems.append(RowProblem(
                            category=Cat.DUPLICATE,
                            severity=SEV_WARN,
                            row_number=i,
                            field=",".join(contract.business_key),
                            raw_value=key_values,
                            detail=(
                                f"Business key {key_values!r} was already seen in "
                                f"row {seen_keys[key_values]}."
                            ),
                            resolution="Review the duplicate and choose an explicit "
                                       "keep/replace policy; no row was silently dropped.",
                        ))
                    else:
                        seen_keys[key_values] = i
            except (TypeError, ValueError):
                # The row validator already reports the underlying type issue.
                pass

        result.rows.append(vr)
        result.problems.extend(vr.problems)
        if vr.accepted:
            result.accepted_rows += 1
        else:
            result.rejected_rows += 1
    return result
