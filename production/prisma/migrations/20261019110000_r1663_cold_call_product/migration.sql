-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cold_call_campaigns' and column_name = 'product_name')
-- deploy-key: r1663coldproduct
-- prisma/migrations/20261019110000_r1663_cold_call_product
-- R-1663 (Abhishek, 19 Oct 2026): a cold-calling campaign is FOR a product — the agent opens
-- with it, quotes only its prices, and the result says which product the person wanted.
-- product_item_id points at the catalogue row (null = "let the customer choose"); product_name
-- is kept as text so a renamed or removed item does not blank old campaigns. Additive only.
begin;

alter table public.cold_call_campaigns
  add column if not exists product_item_id uuid,
  add column if not exists product_name text check (product_name is null or length(product_name) <= 200);

commit;
