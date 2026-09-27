-- EcomAI-OS — record the selling channel on a sales row.
--
-- Apply after 0008_product_price_and_display_fields.sql.
--
-- Why this migration exists
-- ------------------------
-- The UI has always had a "Sales by Channel" breakdown, but the canonical sales
-- contract had no channel column, so that panel could never have data. This
-- adds the column and widens the upsert key so the same product can be recorded
-- once per channel on the same day.
--
-- Backfill
-- --------
-- `channel` is NOT NULL with a default rather than nullable. That is deliberate:
-- NULL values are distinct in a unique index, so nullable channel would make
-- every pre-existing unchanneled row its own key and a re-upload would silently
-- duplicate history instead of updating it. With a stated default, the key
-- component is always defined and the upsert stays deterministic.
--
-- Existing rows are all labelled 'unrecorded' -- the UI renders that as
-- "Not recorded". Nothing is attributed to a channel that did not claim it.
--
-- Rows already written keep their old unique constraint until the new index
-- exists, so the sequence below cannot leave the table without a key.
--
-- The default is left in place deliberately: it is a backstop for any writer
-- that omits the column, not the normal path. The application always sends an
-- explicit channel.

alter table public.sales
  add column if not exists channel text not null default 'unrecorded';

comment on column public.sales.channel is
  'Selling channel label, or ''unrecorded'' when the source stated none. Part of the upsert key with (user_id, product_id, date).';

-- The old two-column key can no longer express the contract: two channels on
-- one day would collide. Replace it rather than layering a second index on top.
drop index if exists public.sales_tenant_product_date_key;

create unique index if not exists sales_tenant_product_date_channel_key
  on public.sales (user_id, product_id, date, channel);

-- (user_id, date) is still the useful index for range scans and the portfolio
-- rollup, and is unaffected by the added column.
