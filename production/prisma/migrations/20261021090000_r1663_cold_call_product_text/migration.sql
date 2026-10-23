-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cold_call_campaigns' and column_name = 'product_item_id' and data_type = 'text')
-- deploy-key: r1663coldproducttext
-- prisma/migrations/20261021090000_r1663_cold_call_product_text
-- R-1663 fix (Abhishek, 21 Oct 2026): items.id is TEXT ("GW-STARTER"), not a uuid, so the
-- uuid column added in 20261019110000 could not hold any real product and every campaign with
-- a product failed to save. Widen it to text. No rows can hold a value yet (none could be
-- written), so the cast is safe.
begin;

alter table public.cold_call_campaigns
  alter column product_item_id type text using product_item_id::text;

commit;
