\set ON_ERROR_STOP on
-- R-2132 (GP-16b, goal G-PERSONAL): a personal login reads the bills of the Anutech customer it is
-- linked to (personal_identity_link, GP-16a) — invoices, quotes, payments and subscriptions —
-- and nothing else. Migration 20261030160500_gp16b_personal_my_bills.sql. Rolled back — safe anywhere.
--
--   0  the four functions exist; anon cannot execute them
--   1  the linked user sees ONLY their customer's invoices (no drafts), quotes (no drafts),
--      payments and subscriptions — never the other customer's
--   2  another linked user sees only their own (0 of the first user's)
--   3  a user with NO link gets 0 rows, not an error
--   4  a gated link (needs_decision, no customer) gets 0 rows, not an error
--   5  the seller's own owner (business login, no link) gets 0 rows
--   6  internal columns stay out (no cost/list_rate in quote lines, no gateway fee/bank on payments)

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code, tier) values
  ('21320000-0000-4000-8000-0000000000a1', 'ZZ GP16B SELLER', 'gp16b-seller@example.invalid', '07', 'G6BS', 'reseller'),
  ('21320000-0000-4000-8000-0000000000b1', 'ZZ GP16B Personal One', 'gp16b-p1@example.invalid', '07', 'G6BP1', 'reseller'),
  ('21320000-0000-4000-8000-0000000000b2', 'ZZ GP16B Personal Two', 'gp16b-p2@example.invalid', '07', 'G6BP2', 'reseller'),
  ('21320000-0000-4000-8000-0000000000b3', 'ZZ GP16B Personal Three', 'gp16b-p3@example.invalid', '07', 'G6BP3', 'reseller'),
  ('21320000-0000-4000-8000-0000000000b4', 'ZZ GP16B Personal Four', 'gp16b-p4@example.invalid', '07', 'G6BP4', 'reseller');
update public.tenants set workspace_kind = 'personal'
 where id in ('21320000-0000-4000-8000-0000000000b1', '21320000-0000-4000-8000-0000000000b2',
              '21320000-0000-4000-8000-0000000000b3', '21320000-0000-4000-8000-0000000000b4');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data) values
  ('21320000-0000-4000-8000-0000000000e0', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gp16b-owner@example.invalid', now(), '{}'),
  ('21320000-0000-4000-8000-0000000000e1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'one.gp16b@example.invalid', now(), '{}'),
  ('21320000-0000-4000-8000-0000000000e2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'two.gp16b@example.invalid', now(), '{}'),
  ('21320000-0000-4000-8000-0000000000e3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nolink.gp16b@example.invalid', now(), '{}'),
  ('21320000-0000-4000-8000-0000000000e4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gated.gp16b@example.invalid', now(), '{}');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('21320000-0000-4000-8000-0000000000e0', '21320000-0000-4000-8000-0000000000a1', 'gp16b-owner@example.invalid', 'Seller Owner', 'owner', true),
  ('21320000-0000-4000-8000-0000000000e1', '21320000-0000-4000-8000-0000000000b1', 'one.gp16b@example.invalid', 'Person One', 'personal', true),
  ('21320000-0000-4000-8000-0000000000e2', '21320000-0000-4000-8000-0000000000b2', 'two.gp16b@example.invalid', 'Person Two', 'personal', true),
  ('21320000-0000-4000-8000-0000000000e3', '21320000-0000-4000-8000-0000000000b3', 'nolink.gp16b@example.invalid', 'No Link', 'personal', true),
  ('21320000-0000-4000-8000-0000000000e4', '21320000-0000-4000-8000-0000000000b4', 'gated.gp16b@example.invalid', 'Gated', 'personal', true);

insert into public.customers (id, tenant_id, name, contact_email, customer_type) values
  ('21320000-0000-4000-8000-0000000000c1', '21320000-0000-4000-8000-0000000000a1', 'Person One', 'one.gp16b@example.invalid', 'individual'),
  ('21320000-0000-4000-8000-0000000000c2', '21320000-0000-4000-8000-0000000000a1', 'Person Two', 'two.gp16b@example.invalid', 'individual');

-- links as link_personal_identity (GP-16a) leaves them; the gated one has no customer
insert into public.personal_identity_link (auth_user_id, personal_tenant_id, seller_tenant_id, anutech_customer_id, email, link_status) values
  ('21320000-0000-4000-8000-0000000000e1', '21320000-0000-4000-8000-0000000000b1', '21320000-0000-4000-8000-0000000000a1', '21320000-0000-4000-8000-0000000000c1', 'one.gp16b@example.invalid', 'linked'),
  ('21320000-0000-4000-8000-0000000000e2', '21320000-0000-4000-8000-0000000000b2', '21320000-0000-4000-8000-0000000000a1', '21320000-0000-4000-8000-0000000000c2', 'two.gp16b@example.invalid', 'linked'),
  ('21320000-0000-4000-8000-0000000000e4', '21320000-0000-4000-8000-0000000000b4', '21320000-0000-4000-8000-0000000000a1', null, 'gated.gp16b@example.invalid', 'needs_decision');

-- customer one: 1 pending invoice + 1 draft invoice, 1 sent quote + 1 draft quote, 1 payment, 1 subscription
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date) values
  ('ZZ-G16B-INV1', '21320000-0000-4000-8000-0000000000a1', '21320000-0000-4000-8000-0000000000c1', 'Person One', 1180, 'pending', current_date, current_date + 7),
  ('ZZ-G16B-INVD', '21320000-0000-4000-8000-0000000000a1', '21320000-0000-4000-8000-0000000000c1', 'Person One', 590, 'draft', current_date, current_date + 7),
  ('ZZ-G16B-INV2', '21320000-0000-4000-8000-0000000000a1', '21320000-0000-4000-8000-0000000000c2', 'Person Two', 2360, 'pending', current_date, current_date + 7);

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, line_items) values
  ('ZZ-G16B-Q1', '21320000-0000-4000-8000-0000000000a1', '21320000-0000-4000-8000-0000000000c1', 'Person One', 1180, 'sent',
   '[{"id":"l1","name":"Workspace","qty":1,"rate":1000,"cost":700,"list_rate":1200}]'),
  ('ZZ-G16B-QD', '21320000-0000-4000-8000-0000000000a1', '21320000-0000-4000-8000-0000000000c1', 'Person One', 590, 'draft', '[]'),
  ('ZZ-G16B-Q2', '21320000-0000-4000-8000-0000000000a1', '21320000-0000-4000-8000-0000000000c2', 'Person Two', 2360, 'sent', '[]');

insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at, gateway_fee) values
  ('21320000-0000-4000-8000-0000000000f1', '21320000-0000-4000-8000-0000000000a1', 'ZZ-G16B-Q1', '21320000-0000-4000-8000-0000000000c1', 1180, 'upi', 'received', now(), 20),
  ('21320000-0000-4000-8000-0000000000f2', '21320000-0000-4000-8000-0000000000a1', 'ZZ-G16B-Q2', '21320000-0000-4000-8000-0000000000c2', 2360, 'upi', 'received', now(), null);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, renewal_date) values
  ('21320000-0000-4000-8000-0000000000d1', '21320000-0000-4000-8000-0000000000a1', '21320000-0000-4000-8000-0000000000c1', 'Person One', 'Business Starter', 'google', 1, 300, 'active', (current_date + 365)),
  ('21320000-0000-4000-8000-0000000000d2', '21320000-0000-4000-8000-0000000000a1', '21320000-0000-4000-8000-0000000000c2', 'Person Two', 'Business Plus', 'google', 2, 900, 'active', (current_date + 365));

-- ── 0: the functions exist; anon may not run them ────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['personal_my_invoices()', 'personal_my_quotes()', 'personal_my_payments()', 'personal_my_subscriptions()'] loop
    if to_regprocedure('public.' || f) is null then raise exception 'FAIL 0: public.% does not exist', f; end if;
    if has_function_privilege('anon', 'public.' || f, 'execute') then raise exception 'FAIL 0b: anon can execute %', f; end if;
    if not has_function_privilege('authenticated', 'public.' || f, 'execute') then raise exception 'FAIL 0c: authenticated cannot execute %', f; end if;
  end loop;
end $$;

set local role authenticated;

-- ── 1: the linked user sees only their customer's rows ───────────────────────
select set_config('request.jwt.claims', json_build_object('sub','21320000-0000-4000-8000-0000000000e1','role','authenticated')::text, true);
do $$
declare v_ids text; v_n int; v_lines jsonb; v_pay jsonb;
begin
  select string_agg(id, ',' order by id) into v_ids from public.personal_my_invoices();
  if v_ids is distinct from 'ZZ-G16B-INV1' then raise exception 'FAIL 1a: invoices % (expected ZZ-G16B-INV1 only — no draft, no other customer)', v_ids; end if;
  select string_agg(id, ',' order by id) into v_ids from public.personal_my_quotes();
  if v_ids is distinct from 'ZZ-G16B-Q1' then raise exception 'FAIL 1b: quotes % (expected ZZ-G16B-Q1 only)', v_ids; end if;
  select string_agg(id::text, ',' order by id) into v_ids from public.personal_my_payments();
  if v_ids is distinct from '21320000-0000-4000-8000-0000000000f1' then raise exception 'FAIL 1c: payments % (expected f1 only)', v_ids; end if;
  select string_agg(id::text, ',' order by id) into v_ids from public.personal_my_subscriptions();
  if v_ids is distinct from '21320000-0000-4000-8000-0000000000d1' then raise exception 'FAIL 1d: subscriptions % (expected d1 only)', v_ids; end if;

  -- ── 6: internal columns stay out ──────────────────────────────────────────
  select line_items into v_lines from public.personal_my_quotes() where id = 'ZZ-G16B-Q1';
  if v_lines->0 ? 'cost' or v_lines->0 ? 'list_rate' then raise exception 'FAIL 6a: quote line leaks cost/list_rate: %', v_lines; end if;
  if (v_lines->0->>'rate')::int <> 1000 then raise exception 'FAIL 6b: quote line lost its rate: %', v_lines; end if;
  select to_jsonb(p) into v_pay from public.personal_my_payments() p limit 1;
  if v_pay ? 'gateway_fee' or v_pay ? 'bank_account_id' or v_pay ? 'notes' or v_pay ? 'recorded_by' then
    raise exception 'FAIL 6c: payment row leaks internal fields: %', v_pay;
  end if;
  select balance_due into v_n from public.personal_my_invoices() where id = 'ZZ-G16B-INV1';
  if v_n is distinct from 1180 then raise exception 'FAIL 6d: balance_due % (expected 1180)', v_n; end if;
end $$;

-- ── 2: another linked user sees only their own ───────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub','21320000-0000-4000-8000-0000000000e2','role','authenticated')::text, true);
do $$
declare v_ids text;
begin
  select string_agg(id, ',' order by id) into v_ids from public.personal_my_invoices();
  if v_ids is distinct from 'ZZ-G16B-INV2' then raise exception 'FAIL 2a: user two saw invoices %', v_ids; end if;
  select string_agg(id, ',' order by id) into v_ids from public.personal_my_quotes();
  if v_ids is distinct from 'ZZ-G16B-Q2' then raise exception 'FAIL 2b: user two saw quotes %', v_ids; end if;
  select string_agg(id::text, ',' order by id) into v_ids from public.personal_my_payments();
  if v_ids is distinct from '21320000-0000-4000-8000-0000000000f2' then raise exception 'FAIL 2c: user two saw payments %', v_ids; end if;
  select string_agg(id::text, ',' order by id) into v_ids from public.personal_my_subscriptions();
  if v_ids is distinct from '21320000-0000-4000-8000-0000000000d2' then raise exception 'FAIL 2d: user two saw subscriptions %', v_ids; end if;
end $$;

-- ── 3/4/5: no link, gated link, business owner → 0 rows, no error ────────────
do $$
declare u text; v_n int;
begin
  foreach u in array array['21320000-0000-4000-8000-0000000000e3', '21320000-0000-4000-8000-0000000000e4', '21320000-0000-4000-8000-0000000000e0'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    select (select count(*) from public.personal_my_invoices()) + (select count(*) from public.personal_my_quotes())
         + (select count(*) from public.personal_my_payments()) + (select count(*) from public.personal_my_subscriptions())
      into v_n;
    if v_n <> 0 then raise exception 'FAIL 3: user % (no usable link) got % rows', u, v_n; end if;
  end loop;
end $$;

do $$ begin raise notice 'gp16b_personal_my_bills: all checks passed'; end $$;

rollback;
