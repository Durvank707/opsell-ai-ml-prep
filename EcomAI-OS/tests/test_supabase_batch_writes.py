"""Regression tests for the Supabase write path's batch and failure reporting.

Two defects lived here, and both are invisible until a real project is behind
the adapter:

* a bulk insert whose rows carried different key sets was answered with a bare
  HTTP 400 by PostgREST (PGRST103, "All object keys must match"), because a
  payload builder dropped any optional field the row happened not to state. A
  perfectly valid file failed for every tenant whose rows differed in which
  optional cells were blank;
* the message the tenant saw was only "HTTP status 400", which names no field, no
  migration and no cause, so there was nothing to act on.

The tests below pin the uniform key set, and the safe explanation for each
failure the adapter knows how to name.
"""

import json
from urllib.error import HTTPError

import pytest

from backend.supabase import (
    SupabasePersistenceError,
    _canonical_product_payloads,
    _canonical_sales_payloads,
    _explain_http_failure,
    _MAX_EXPLANATION,
    upsert_products,
    upsert_sales,
)

# The canonical product columns, as the shipped 14-column template defines them.
PRODUCT_ROW_FULL = {
    "product_id": "P001",
    "product_name": "Wireless Headphones",
    "category": "Electronics",
    "current_stock": "225",
    "open_order_qty": "0",
    "expected_arrival_date": "2026-10-05",
    "lead_time_days": "4",
    "unit_cost": "1000",
    "safety_stock": "20",
    "reorder_point": "60",
    "unit_price": "1999",
    "supplier": "Acme Audio",
    "description": "Flagship headset",
    "forecast_error_std": "6.2",
}
# The same product with every optional cell left blank -- a merchant's real file,
# and the row that used to make the *next* row's key set disagree with it.
PRODUCT_ROW_BARE = {
    "product_id": "P003",
    "product_name": "Bare Widget",
    "category": "",
    "current_stock": "5",
    "open_order_qty": "",
    "expected_arrival_date": "",
    "lead_time_days": "",
    "unit_cost": "",
    "safety_stock": "",
    "reorder_point": "",
    "unit_price": "",
    "supplier": "",
    "description": "",
    "forecast_error_std": "",
}

SALES_ROW_PRICED = {
    "date": "2026-09-01",
    "product_id": "P001",
    "units_sold": "5",
    "price": "799",
    "category": "Electronics",
    "promotion": "false",
    "channel": "Online Store",
}
SALES_ROW_UNPRICED = {
    "date": "2026-09-02",
    "product_id": "P001",
    "units_sold": "2",
    "price": "",
    "category": "",
    "promotion": "",
    "channel": "",
}


def _key_set(rows):
    return {tuple(sorted(row)) for row in rows}


def test_every_product_row_carries_the_same_columns():
    """The 400 that a mixed-optionality file caused, pinned shut.

    PostgREST rejects a bulk insert whose objects disagree about their keys
    (PGRST103), and the adapter used to emit exactly that whenever one row
    stated `supplier` and the next did not.
    """

    payloads = _canonical_product_payloads(
        "tenant-a", [PRODUCT_ROW_FULL, PRODUCT_ROW_BARE, dict(PRODUCT_ROW_FULL, product_id="P004", product_name="Second")]
    )

    assert len(_key_set(payloads)) == 1, "rows must agree on their columns"


def test_an_absent_optional_product_value_is_sent_as_null_not_dropped():
    """Absent is written as null, which every one of these columns allows.

    Dropping the key is what made a batch's key set depend on the data in it;
    sending an explicit null keeps the shape fixed and still stores the
    difference between "no supplier" and "not supplied".
    """

    payloads = _canonical_product_payloads("tenant-a", [PRODUCT_ROW_BARE])

    row = payloads[0]
    assert row["supplier"] is None
    assert row["description"] is None
    assert row["expected_arrival_date"] is None
    assert row["unit_price"] is None
    # The values a tenant must supply are never nulled away.
    assert row["product_id"] == "P003"
    assert row["current_stock"] == 5


def test_a_column_the_schema_declares_not_null_is_sent_as_its_default():
    """`open_order_qty` is `not null default 0`, so null is not an option.

    This one only shows up against a real project. Postgres applies a column
    default only when the column is *omitted*, and omitting keys is what
    PostgREST refuses in a bulk insert, so a uniform key set has to carry the
    default value instead: without it every product row that left the column
    blank was refused with "open_order_qty cannot be null" and the whole file
    failed.
    """

    payloads = _canonical_product_payloads(
        "tenant-a",
        [
            PRODUCT_ROW_BARE,
            {
                # The column absent from the source entirely, rather than blank.
                **{
                    k: v
                    for k, v in PRODUCT_ROW_BARE.items()
                    if k not in ("open_order_qty", "product_id")
                },
                "product_id": "P004",
            },
            dict(PRODUCT_ROW_BARE, product_id="P005", open_order_qty="12"),
        ],
    )

    # Unstated, blank and stated all produce the same key set, and the two
    # unstated rows carry the column's default rather than a null.
    assert len(_key_set(payloads)) == 1
    assert payloads[0]["open_order_qty"] == 0
    assert payloads[1]["open_order_qty"] == 0
    assert payloads[2]["open_order_qty"] == 12
    assert isinstance(payloads[0]["open_order_qty"], int)


def test_every_sales_row_carries_the_same_columns():
    payloads = _canonical_sales_payloads("tenant-a", [SALES_ROW_PRICED, SALES_ROW_UNPRICED])

    assert len(_key_set(payloads)) == 1
    assert payloads[1]["price"] is None
    # channel is part of the upsert key, so an unstated one is the explicit
    # 'unrecorded' label rather than a missing column.
    assert payloads[1]["channel"] == "unrecorded"


def test_a_uniform_batch_is_what_reaches_the_wire(monkeypatch):
    """The end-to-end shape: one POST, one key set, no gap for a 400 to enter."""

    captured = {}

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b"[]"

    def fake_urlopen(request, timeout):
        table = request.full_url.split("/rest/v1/")[1].split("?")[0]
        captured[table] = json.loads(request.data.decode("utf-8"))
        return _Response()

    monkeypatch.setenv("USE_SUPABASE", "true")
    monkeypatch.setenv("SUPABASE_URL", "https://mock-project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")
    monkeypatch.setattr("backend.supabase._urlopen", fake_urlopen)

    upsert_products("tenant-a", [PRODUCT_ROW_FULL, PRODUCT_ROW_BARE])
    upsert_sales("tenant-a", [SALES_ROW_PRICED, SALES_ROW_UNPRICED])

    products, sales = captured["products"], captured["sales"]
    assert len(_key_set(products)) == 1
    assert len(_key_set(sales)) == 1
    # Both rows of each batch are stamped with the calling tenant, never a
    # caller-supplied one.
    assert {row["user_id"] for row in products} == {"tenant-a"}
    assert {row["user_id"] for row in sales} == {"tenant-a"}


def _body_error(status, payload):
    """A real HTTPError carrying a JSON body, as PostgREST sends one."""

    import io

    return HTTPError(
        "https://mock-project.supabase.co/rest/v1/products",
        status,
        "Bad Request",
        {},
        io.BytesIO(json.dumps(payload).encode("utf-8")),
    )


def test_a_rejected_column_names_the_column_and_the_migration():
    """The actionable half of the fix: a name and a next step, not "HTTP 400"."""

    message = _explain_http_failure(
        "products",
        400,
        json.dumps({
            "code": "PGRST204",
            "message": "Could not find the 'unit_price' column of 'products' in the schema cache",
        }),
    )

    assert "unit_price" in message
    assert "0008_product_price_and_display_fields.sql" in message
    assert "No data was written" in message


def test_a_missing_column_read_from_a_plain_postgres_message_is_named():
    message = _explain_http_failure(
        "sales",
        400,
        json.dumps({
            "code": "42703",
            "message": 'column channel of relation "sales" does not exist',
        }),
    )

    assert "channel" in message
    assert "0009_sales_channel.sql" in message


def test_a_mixed_key_batch_is_reported_as_a_server_defect_not_the_users_file():
    message = _explain_http_failure(
        "products",
        400,
        json.dumps({"code": "PGRST103", "message": "All object keys must match"}),
    )

    assert "server-side defect" in message
    assert "your file" in message
    assert "Nothing was written" in message


def test_a_not_null_value_names_the_field():
    message = _explain_http_failure(
        "products",
        400,
        json.dumps({
            "code": "23502",
            "message": 'null value in column "product_name" of relation "products" violates not-null constraint',
        }),
    )

    assert "product_name" in message
    assert "cannot be empty" in message


def test_a_check_constraint_is_reported_against_the_column_it_checks():
    message = _explain_http_failure(
        "products",
        400,
        json.dumps({
            "code": "23514",
            "message": 'new row for relation "products" violates check constraint "products_current_stock_check"',
        }),
    )

    assert "current_stock" in message
    assert "outside" in message


def test_a_duplicate_key_does_not_claim_an_overwrite_happened():
    message = _explain_http_failure(
        "products",
        409,
        json.dumps({
            "code": "23505",
            "message": 'duplicate key value violates unique constraint "products_user_id_product_id_key"',
            "details": "Key (user_id, product_id)=(tenant-a, P001) already exists.",
        }),
    )

    assert "product_id" in message
    assert "Nothing was overwritten" in message
    # The conflicting row's own values are not echoed back to the caller.
    assert "tenant-a" not in message


def test_a_missing_table_names_the_migration_that_creates_it():
    message = _explain_http_failure(
        "sales",
        400,
        json.dumps({"code": "42P01", "message": 'relation "sales" does not exist'}),
    )

    assert "0007_full_schema.sql" in message


def test_an_rls_block_is_named_as_such():
    message = _explain_http_failure(
        "products",
        400,
        json.dumps({"code": "PT008", "message": "Payload did not contain any rows"}),
    )

    assert "Row Level Security" in message


def test_an_unmapped_failure_still_names_the_code_and_writes_nothing():
    message = _explain_http_failure(
        "products",
        400,
        json.dumps({"code": "PGRST999", "message": "something new"}),
    )

    assert "PGRST999" in message
    assert "nothing was written" in message.lower()


def test_a_transport_level_refusal_names_the_status_only():
    for status in (401, 403):
        message = _explain_http_failure("products", status, b"")
        assert str(status) in message
        assert "nothing was written" in message.lower()


def test_no_failure_echoes_the_database_body():
    """A body can contain request values, a key or a stack trace. None of it
    may reach the tenant; only the code and a column name are read."""

    secret = "service_role_key=super-secret-token"
    body = json.dumps({
        "code": "23505",
        "message": f'duplicate key value violates unique constraint "x" {secret}',
        "details": f'Key (a,b)=(1,2) already exists. {secret}',
    })

    message = _explain_http_failure("products", 409, body)

    assert "super-secret-token" not in message
    assert "service_role_key" not in message
    assert len(message) <= _MAX_EXPLANATION


@pytest.mark.parametrize(
    "body",
    [
        b"",
        b"not json at all",
        json.dumps(["a", "list"]),
        json.dumps({"code": "'; drop table products; --"}),
        json.dumps({"message": "column 'x' of relation 'y' does not exist" * 50}),
    ],
)
def test_an_unusable_body_degrades_to_a_short_safe_message(body):
    message = _explain_http_failure("products", 400, body)

    assert message
    assert len(message) <= _MAX_EXPLANATION
    assert "drop table" not in message


def test_a_400_raises_the_explanation_rather_than_the_status(monkeypatch):
    """What the ingest route actually surfaces to a tenant."""

    def fake_urlopen(request, timeout):
        # `urllib` raises the error itself; only the transport is replaced here.
        raise _body_error(
            400,
            {
                "code": "PGRST103",
                "message": "All object keys must match",
                "hint": "advisory",
            },
        )

    monkeypatch.setenv("USE_SUPABASE", "true")
    monkeypatch.setenv("SUPABASE_URL", "https://mock-project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")
    monkeypatch.setattr("backend.supabase._urlopen", fake_urlopen)

    with pytest.raises(SupabasePersistenceError) as excinfo:
        upsert_products("tenant-a", [PRODUCT_ROW_FULL, PRODUCT_ROW_BARE])

    message = str(excinfo.value)
    assert "HTTP status 400" not in message
    assert "server-side defect" in message
