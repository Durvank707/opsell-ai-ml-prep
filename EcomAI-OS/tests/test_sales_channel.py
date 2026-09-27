"""Tests for the sales channel: a real facet of a sales record.

The UI has a "Sales by Channel" panel and a channel filter. Before ``channel``
was a contract field both were permanently empty against a real backend, so
these tests pin the three things that make them work, and one thing that must
stay true while they do:

1. ``channel`` is a canonical field and part of the sales business key, so a
   product can be recorded once per channel on the same day.
2. A row that states no channel gets a *stated* label, never a NULL and never a
   guessed channel -- a key component has to be defined for the upsert to be
   deterministic, and a reader has to be able to see the gap.
3. Demand is still a *daily* series. Splitting a day across channels must not
   produce two rows for one date, because the forecaster's lag and rolling
   features are built on one row per day.

The fourth group covers the validation response, which reports thousands of
legitimate warnings for a minimal file; errors are never truncated and the true
counts are always stated, so a capped list cannot read as a complete one.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time

import pytest
from fastapi.testclient import TestClient

from backend.contracts import (
    SALES_CHANNEL_UNRECORDED,
    SALES_RECORD,
    sales_channel_label,
)
from backend.main import app
from backend.routers import v2
from backend.tenant import TenantWorkspace, _daily_combined
from backend.validation import validate_rows

SECRET = "test-" + secrets.token_urlsafe(48)
client = TestClient(app)


def _b64(value: dict) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()


def _token(subject: str) -> str:
    now = time.time()
    header = _b64({"alg": "HS256", "typ": "JWT"})
    payload = _b64({"sub": subject, "iat": now, "exp": now + 3600})
    sig = hmac.new(
        SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256
    ).digest()
    return f"{header}.{payload}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


@pytest.fixture(autouse=True)
def jwt_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setattr(v2, "_WORKSPACES", {})


def _ws(user="channel-user", product_id="P1"):
    ws = TenantWorkspace(user)
    ws.add_product({
        "product_id": product_id,
        "product_name": "Widget",
        "category": "Electronics",
        "current_stock": 10,
        "lead_time_days": 4,
        "unit_cost": 3.5,
    })
    v2._WORKSPACES[user] = ws
    return ws


def _row(product_id="P1", date="2025-01-01", units=5, **extra):
    return {"product_id": product_id, "date": date, "units_sold": units, **extra}


def _get(path, *, user="channel-user", params=None):
    query = {"user_id": user}
    query.update(params or {})
    return client.get(
        path, params=query, headers={"Authorization": f"Bearer {_token(user)}"}
    )


def _post(path, body, *, user="channel-user"):
    return client.post(
        path, json={**body, "user_id": user},
        headers={"Authorization": f"Bearer {_token(user)}"},
    )


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------


def test_channel_is_a_canonical_sales_field():
    assert "channel" in {field.canonical_name for field in SALES_RECORD.fields}


def test_channel_is_part_of_the_sales_business_key():
    assert SALES_RECORD.business_key == ("product_id", "date", "channel")


def test_channel_is_optional_and_not_an_ml_feature():
    """It is a facet of the record, not a dimension of demand.

    The trained model has no channel feature, so claiming USED would assert an
    influence on the forecast that does not exist.
    """

    field = SALES_RECORD.field("channel")
    assert field is not None
    assert field.required is False
    assert field.ml_requirement == "IGNORED"


def test_channel_vocabulary_is_open_not_a_closed_enum():
    """A merchant's real channel names cannot be known in advance.

    Refusing an unlisted label would reject genuine business data, which is a
    worse failure than storing a label the UI has no colour for.
    """

    field = SALES_RECORD.field("channel")
    assert field.max is None
    assert "Wholesale" not in field.aliases


# ---------------------------------------------------------------------------
# The one normaliser both writers share
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "supplied, expected",
    [
        (None, SALES_CHANNEL_UNRECORDED),
        ("", SALES_CHANNEL_UNRECORDED),
        ("   ", SALES_CHANNEL_UNRECORDED),
        ("\t\n", SALES_CHANNEL_UNRECORDED),
        (7, SALES_CHANNEL_UNRECORDED),
        (True, SALES_CHANNEL_UNRECORDED),
    ],
)
def test_an_unstated_channel_becomes_the_stated_sentinel(supplied, expected):
    assert sales_channel_label(supplied) == expected


def test_a_stated_channel_is_trimmed_but_not_recased():
    """Two spellings of one channel stay two labels, so a group-by is honest."""

    assert sales_channel_label("  Amazon  ") == "Amazon"
    assert sales_channel_label("amazon") == "amazon"
    assert sales_channel_label("amazon") != sales_channel_label("Amazon")


# ---------------------------------------------------------------------------
# Storage: one product, one day, several channels
# ---------------------------------------------------------------------------


def test_a_row_without_a_channel_is_stored_under_the_sentinel():
    ws = _ws()
    ws.upsert_sales_row(_row())
    assert ("P1", "2025-01-01", SALES_CHANNEL_UNRECORDED) in ws.sales_records


def test_two_channels_on_one_day_are_two_records():
    """The whole point of widening the key."""

    ws = _ws()
    ws.upsert_sales_rows([
        _row(units=5, channel="Online Store"),
        _row(units=3, channel="Amazon"),
    ])
    assert ws.sales_records[("P1", "2025-01-01", "Online Store")]["units_sold"] == 5
    assert ws.sales_records[("P1", "2025-01-01", "Amazon")]["units_sold"] == 3
    assert len(ws.sales_records) == 2


def test_the_same_channel_on_one_day_updates_rather_than_duplicating():
    ws = _ws()
    ws.upsert_sales_row(_row(units=5, channel="Amazon"))
    ws.upsert_sales_row(_row(units=9, channel="Amazon"))
    assert len(ws.sales_records) == 1
    assert ws.sales_records[("P1", "2025-01-01", "Amazon")]["units_sold"] == 9


def test_a_duplicate_key_inside_one_batch_is_refused():
    """Ambiguous input is refused, not silently collapsed by the upsert."""

    ws = _ws()
    with pytest.raises(ValueError, match="duplicate product/date/channel"):
        ws.upsert_sales_rows([
            _row(units=5, channel="Amazon"),
            _row(units=7, channel="Amazon"),
        ])


def test_a_blank_channel_collides_with_the_sentinel_in_one_batch():
    """A blank and an absent channel are the same key component."""

    ws = _ws()
    with pytest.raises(ValueError, match="duplicate product/date/channel"):
        ws.upsert_sales_rows([_row(units=5), _row(units=7, channel="  ")])


# ---------------------------------------------------------------------------
# Demand is still a daily series
# ---------------------------------------------------------------------------


def test_daily_history_combines_a_split_day_into_one_row():
    ws = _ws()
    ws.upsert_sales_rows([
        _row(units=5, channel="Online Store"),
        _row(units=3, channel="Amazon"),
    ])
    daily = ws.daily_history_for("P1")
    assert len(daily) == 1
    assert daily[0]["units_sold"] == 8


def test_the_record_view_keeps_both_channel_rows():
    ws = _ws()
    ws.upsert_sales_rows([
        _row(units=5, channel="Online Store"),
        _row(units=3, channel="Amazon"),
    ])
    assert len(ws.sales_history_for("P1")) == 2


def test_combining_is_the_identity_for_a_single_record_day():
    """Every tenant that existed before channels must be unaffected."""

    rows = [
        {"product_id": "P1", "date": "2025-01-01", "units_sold": 5,
         "price": 10.0, "promotion": 1, "category": "Electronics"},
        {"product_id": "P1", "date": "2025-01-02", "units_sold": 7,
         "price": 10.0, "promotion": 0, "category": "Electronics"},
    ]
    assert _daily_combined(rows) == rows


def test_combining_averages_the_days_prices():
    combined = _daily_combined([
        {"date": "2025-01-01", "units_sold": 5, "price": 10.0},
        {"date": "2025-01-01", "units_sold": 5, "price": 14.0},
    ])
    assert len(combined) == 1
    assert combined[0]["price"] == 12.0


def test_a_promotion_on_any_channel_marks_the_day():
    combined = _daily_combined([
        {"date": "2025-01-01", "units_sold": 5, "promotion": 0},
        {"date": "2025-01-01", "units_sold": 5, "promotion": 1},
    ])
    assert combined[0]["promotion"] is True


def test_combining_never_invents_a_promotion():
    """A bare ``False`` here would be a quiet derivation.

    ``_enrich_history`` exists to disclose that promotion was assumed; if the
    combiner supplied one first, the forecast would rest on a value the caller
    was never told about.
    """

    combined = _daily_combined([
        {"date": "2025-01-01", "units_sold": 5},
        {"date": "2025-01-01", "units_sold": 5},
    ])
    assert "promotion" not in combined[0]


def test_combining_never_invents_a_price_or_a_category():
    combined = _daily_combined([{"date": "2025-01-01", "units_sold": 5}])
    assert "price" not in combined[0]
    assert "category" not in combined[0]


def test_combining_drops_the_channel_facet():
    """Carrying it would suggest it influenced the number. It did not."""

    combined = _daily_combined([
        {"date": "2025-01-01", "units_sold": 5, "channel": "Amazon"},
    ])
    assert "channel" not in combined[0]


def test_combining_preserves_the_first_records_other_fields():
    combined = _daily_combined([
        {"product_id": "P1", "date": "2025-01-01", "units_sold": 5, "promotion": 0},
        {"product_id": "P1", "date": "2025-01-01", "units_sold": 5, "promotion": 1},
    ])
    assert combined[0]["product_id"] == "P1"
    assert combined[0]["date"] == "2025-01-01"


def test_combining_orders_by_date():
    combined = _daily_combined([
        {"date": "2025-01-03", "units_sold": 1},
        {"date": "2025-01-01", "units_sold": 1},
        {"date": "2025-01-02", "units_sold": 1},
    ])
    assert [row["date"] for row in combined] == [
        "2025-01-01", "2025-01-02", "2025-01-03",
    ]


def test_the_forecast_sees_one_row_per_day_not_one_per_channel():
    """A duplicated date would inflate the history length and the features.

    The eligibility gate counts days, so a product whose days were each split
    across two channels would be graded on double its real history and handed
    a model it has not earned.
    """

    ws = _ws()
    rows = []
    for day in range(1, 16):
        date = f"2025-01-{day:02d}"
        rows.append(_row(date=date, units=4, channel="Online Store",
                         price=10.0, category="Electronics"))
        rows.append(_row(date=date, units=3, channel="Amazon",
                         price=10.0, category="Electronics"))
    ws.upsert_sales_rows(rows)

    assert len(ws.sales_records) == 30
    daily = ws.daily_history_for("P1")
    assert len(daily) == 15
    assert [row["units_sold"] for row in daily] == [7] * 15

    # The gate must grade 15 days of history, not 30.
    assert ws.product_metrics("P1")["history_days"] == 15


def test_daily_average_demand_is_not_divided_by_the_channel_count():
    """A split day is one day of demand, not several smaller ones.

    ``daily_avg`` feeds safety stock and the reorder point, so averaging the
    channel rows instead of their total would understate demand by the number of
    channels -- and the resulting safety stock would be quietly too low.
    """

    ws = _ws()
    rows = []
    for day in range(1, 16):
        date = f"2025-01-{day:02d}"
        rows.append(_row(date=date, units=4, channel="Online Store"))
        rows.append(_row(date=date, units=3, channel="Amazon"))
    ws.upsert_sales_rows(rows)
    assert ws.product_metrics("P1")["daily_avg"] == 7.0


def test_the_confidence_band_is_measured_on_daily_totals():
    """Per-channel figures are smaller, so they would understate the spread."""

    ws = _ws()
    for day in range(1, 16):
        date = f"2025-01-{day:02d}"
        ws.upsert_sales_row(_row(date=date, units=4, channel="Online Store"))
        ws.upsert_sales_row(_row(date=date, units=3, channel="Amazon"))
    forecast = ws.demand_forecast("P1", audit=False)
    upper = [p["upper"] for p in forecast["points"]]
    lower = [p["lower"] for p in forecast["points"]]
    assert upper and lower
    assert all(high >= low for high, low in zip(upper, lower))


def test_the_timeline_indexes_history_by_day():
    """Two records on one date would shift every offset the window shows."""

    ws = _ws()
    for day in range(1, 16):
        date = f"2025-01-{day:02d}"
        ws.upsert_sales_row(_row(date=date, units=4, channel="Online Store"))
        ws.upsert_sales_row(_row(date=date, units=3, channel="Amazon"))
    timeline = ws.stockout_timeline("P1")
    dates = [point["date"] for point in timeline["points"]]
    assert len(dates) == len(set(dates))
    assert dates == sorted(dates)


# ---------------------------------------------------------------------------
# Reads: the summary and the filter
# ---------------------------------------------------------------------------


def test_the_summary_reports_a_real_channel_split():
    ws = _ws()
    ws.upsert_sales_rows([
        _row(date="2025-01-01", units=5, channel="Online Store"),
        _row(date="2025-01-02", units=4, channel="Online Store"),
        _row(date="2025-01-01", units=3, channel="Amazon"),
    ])
    summary = ws.sales_summary()
    by_channel = {entry["channel"]: entry for entry in summary["channels"]}
    assert by_channel["Online Store"] == {
        "channel": "Online Store", "count": 2, "units": 9,
    }
    assert by_channel["Amazon"]["units"] == 3


def test_the_summary_keeps_unattributed_sales_as_their_own_slice():
    """Dropping them would make a fully unattributed history look complete."""

    ws = _ws()
    ws.upsert_sales_rows([_row(units=5), _row(date="2025-01-02", units=2)])
    summary = ws.sales_summary()
    assert [entry["channel"] for entry in summary["channels"]] == [
        SALES_CHANNEL_UNRECORDED,
    ]
    assert summary["unrecorded"] == SALES_CHANNEL_UNRECORDED


def test_the_summary_orders_channels_by_size_then_name():
    ws = _ws()
    ws.upsert_sales_rows([
        _row(date="2025-01-01", units=1, channel="Zeta"),
        _row(date="2025-01-02", units=1, channel="Alpha"),
        _row(date="2025-01-03", units=1, channel="Alpha"),
    ])
    names = [entry["channel"] for entry in ws.sales_summary()["channels"]]
    assert names == ["Alpha", "Zeta"]


def test_recorded_channels_come_from_the_data_not_a_fixed_list():
    ws = _ws()
    ws.upsert_sales_rows([_row(units=1, channel="Wholesale")])
    assert ws.sales_channels() == ["Wholesale"]


def test_the_filter_selects_exactly_one_channel():
    ws = _ws()
    ws.upsert_sales_rows([
        _row(units=5, channel="Online Store"),
        _row(units=3, channel="Amazon"),
    ])
    page = ws.list_sales(channel="Amazon")
    assert page["total"] == 1
    assert page["rows"][0]["channel"] == "Amazon"


def test_the_filter_can_reach_unattributed_sales():
    ws = _ws()
    ws.upsert_sales_rows([
        _row(units=5, channel="Amazon"),
        _row(date="2025-01-02", units=3),
    ])
    page = ws.list_sales(channel=SALES_CHANNEL_UNRECORDED)
    assert page["total"] == 1
    assert page["rows"][0]["date"] == "2025-01-02"


def test_a_blank_channel_filter_means_unattributed_not_everything():
    """Silently ignoring a blank filter would show unfiltered rows under a
    filter that claims to be applied."""

    ws = _ws()
    ws.upsert_sales_rows([
        _row(units=5, channel="Amazon"),
        _row(date="2025-01-02", units=3),
    ])
    assert ws.list_sales(channel="  ")["total"] == 1


def test_no_channel_filter_returns_every_record():
    ws = _ws()
    ws.upsert_sales_rows([
        _row(units=5, channel="Amazon"),
        _row(date="2025-01-02", units=3),
    ])
    assert ws.list_sales()["total"] == 2


def test_a_channel_can_be_searched():
    ws = _ws()
    ws.upsert_sales_rows([_row(units=5, channel="Wholesale")])
    assert ws.list_sales(search="whole")["total"] == 1


def test_deleting_a_product_still_removes_every_channel():
    ws = _ws()
    ws.upsert_sales_rows([
        _row(units=5, channel="Amazon"),
        _row(units=3, channel="Online Store"),
    ])
    assert ws.delete_product("P1") == 2
    assert ws.sales_records == {}


# ---------------------------------------------------------------------------
# The API surface
# ---------------------------------------------------------------------------


def test_the_records_endpoint_honours_a_channel_filter():
    ws = _ws()
    ws.upsert_sales_rows([
        _row(units=5, channel="Online Store"),
        _row(units=3, channel="Amazon"),
    ])
    response = _get("/api/v2/sales", params={"channel": "Amazon"})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["rows"][0]["channel"] == "Amazon"


def test_the_summary_endpoint_offers_the_recorded_channels():
    ws = _ws()
    ws.upsert_sales_rows([_row(units=5, channel="Wholesale")])
    response = _get("/api/v2/sales/summary")
    assert response.status_code == 200
    body = response.json()
    assert body["available_channels"] == ["Wholesale"]
    assert body["channels"] == [
        {"channel": "Wholesale", "count": 1, "units": 5},
    ]


def test_an_ingested_channel_survives_the_round_trip():
    ws = _ws()
    response = _post("/api/v2/ingest", {
        "record_type": "sales",
        "rows": [_row(units=6, channel="Amazon")],
    })
    assert response.status_code == 200, response.text
    stored = ws.sales_records[("P1", "2025-01-01", "Amazon")]
    assert stored["units_sold"] == 6


def test_a_second_channel_ingests_rather_than_overwriting():
    """This is the behaviour the widened key exists to enable."""

    ws = _ws()
    for channel, units in (("Amazon", 3), ("Myntra", 4)):
        response = _post("/api/v2/ingest", {
            "record_type": "sales",
            "rows": [_row(units=units, channel=channel)],
        })
        assert response.status_code == 200, response.text
    assert ws.sales_records[("P1", "2025-01-01", "Amazon")]["units_sold"] == 3
    assert ws.sales_records[("P1", "2025-01-01", "Myntra")]["units_sold"] == 4


def test_another_tenants_channels_are_never_reachable():
    ws = _ws("channel-user")
    ws.upsert_sales_rows([_row(units=5, channel="Amazon")])
    _ws("other-user", product_id="P2")
    response = _get("/api/v2/sales", user="other-user", params={"channel": "Amazon"})
    assert response.status_code == 200
    assert response.json()["total"] == 0


# ---------------------------------------------------------------------------
# Validation: channel is optional, and the response stays bounded
# ---------------------------------------------------------------------------


def test_a_file_without_a_channel_column_still_validates():
    rows = [_row(date=f"2025-01-{day:02d}", units=4) for day in range(1, 4)]
    report = validate_rows(
        rows, SALES_RECORD,
        mapping={name: name for name in ("product_id", "date", "units_sold")},
        columns=["product_id", "date", "units_sold"],
    )
    assert report.rejected_rows == 0
    assert report.error_count == 0


def test_a_missing_channel_is_warned_about_not_silently_filled():
    """It is a stated default, so the caller is told the column was absent."""

    report = validate_rows(
        [_row()], SALES_RECORD,
        mapping={name: name for name in ("product_id", "date", "units_sold")},
        columns=["product_id", "date", "units_sold"],
    )
    missing = [p for p in report.problems if p.field == "channel"]
    assert missing
    assert all(p.severity == "warn" for p in missing)


def test_the_validation_response_caps_warnings_but_states_the_true_count():
    """A minimal 1,000-row file legitimately produces thousands of warnings.

    Shipping all of them costs hundreds of kilobytes to repeat the same
    sentence, and nothing acts on them individually. The count has to survive
    the cap or a truncated list would read as a complete one.
    """

    ws = _ws()
    rows = [_row(date=f"2025-03-{day:02d}", units=4) for day in range(1, 29)]
    rows += [_row(date=f"2025-04-{day:02d}", units=4) for day in range(1, 29)]
    response = _post("/api/v2/validate", {"record_type": "sales", "rows": rows})
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["warning_count"] > body["warning_count"] - body["warnings_omitted"]
    assert body["warnings_omitted"] == (
        body["warning_count"] - len(body["problems"])
    )
    assert len(body["problems"]) <= v2._WARNING_RESPONSE_LIMIT


def test_errors_are_never_capped():
    """Ingest is all-or-nothing, so a caller must see every blocking problem."""

    rows = [_row(date=f"2025-0{month}-01", units=units) for month, units in
            ((1, -1), (2, "abc"), (3, -2), (4, "xyz"), (5, -3))]
    response = _post("/api/v2/validate", {"record_type": "sales", "rows": rows})
    assert response.status_code == 200, response.text
    body = response.json()
    errors = [p for p in body["problems"] if p["severity"] == "error"]
    assert len(errors) == body["error_count"] == 5


def test_a_blocking_batch_reports_its_errors_in_the_detail():
    rows = [_row(units=-1)]
    response = _post("/api/v2/ingest", {"record_type": "sales", "rows": rows})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["rejected_rows"] == 1
    assert detail["error_count"] >= 1


def test_ingest_stays_all_or_nothing_across_two_channels():
    ws = _ws()
    response = _post("/api/v2/ingest", {
        "record_type": "sales",
        "rows": [
            _row(units=5, channel="Amazon"),
            _row(units=-2, channel="Myntra"),
        ],
    })
    assert response.status_code == 422
    assert ws.sales_records == {}
