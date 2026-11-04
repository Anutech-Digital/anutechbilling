-- R-2450 (G-NETWORK N2c) — the SELLER sees its customer's answer on its own invoice, credit note
-- and debit note, and as a chip in the invoices list. Migration: 2026110*_r2450_network_seller_status.sql
-- adds network_seller_document_status(text[]): one read for a page of invoice ids. FAILS without it.
--
--   1. an issued invoice to a connected customer reads "pending" with the buyer's name; an invoice to a
--      customer who is not on the network reads nothing (no badge)
--   2. who may read: the seller's owner / manager / accountant AND billing (billing issues and reads
--      invoices — the R-2434 list left it out); sales, another company, and anon read nothing
--   3. the buyer rejects → the seller reads "rejected" + the reason; accepts → "accepted" + when
--   4. a credit note on an accepted invoice comes back under the same invoice id (kind credit_note,
--      seller_note_id = the note)
--   5. more than 500 ids in one call is refused (the list pages are 50 – 200 rows)
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2450_network_seller_status.test.sql

begin;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
-- S seller (proved), B buyer (proved, connected, S shares invoices), O another company.
insert into auth.users (id, email) values
  ('24500000-0000-4000-8000-0000000000a1', 'r2450-owner-s@example.test'),
  ('24500000-0000-4000-8000-0000000000a2', 'r2450-billing-s@example.test'),
  ('24500000-0000-4000-8000-0000000000a3', 'r2450-sales-s@example.test'),
  ('24500000-0000-4000-8000-0000000000b1', 'r2450-owner-b@example.test'),
  ('24500000-0000-4000-8000-0000000000c1', 'r2450-owner-o@example.test');

insert into public.tenants (id, name, email, state_code, doc_code, gstin, gstin_verified_at, workspace_kind) values
  ('24500000-0000-4000-8000-00000000000a', 'R2450 Seller', 'r2450s@example.test', '07', 'R245S', '07AAACR2450S1Z5', now(), 'business'),
  ('24500000-0000-4000-8000-00000000000b', 'R2450 Buyer',  'r2450b@example.test', '07', 'R245B', '07AAACR2450B1Z5', now(), 'business'),
  ('24500000-0000-4000-8000-00000000000c', 'R2450 Other',  'r2450o@example.test', '27', 'R245O', '27AAACR2450O1Z5', now(), 'business');

update public.tenants
   set gstin_owner_verified_at = now(), gstin_owner_verified_gstin = upper(btrim(gstin)),
       gstin_owner_verified_how = 'platform_admin', gstin_owner_verified_by = 'admin@example.test'
 where id in ('24500000-0000-4000-8000-00000000000a', '24500000-0000-4000-8000-00000000000b',
              '24500000-0000-4000-8000-00000000000c');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('24500000-0000-4000-8000-0000000000a1', '24500000-0000-4000-8000-00000000000a', 'r2450-owner-s@example.test',   'R2450 Owner S',   'owner',   true),
  ('24500000-0000-4000-8000-0000000000a2', '24500000-0000-4000-8000-00000000000a', 'r2450-billing-s@example.test', 'R2450 Billing S', 'billing', true),
  ('24500000-0000-4000-8000-0000000000a3', '24500000-0000-4000-8000-00000000000a', 'r2450-sales-s@example.test',   'R2450 Sales S',   'sales',   true),
  ('24500000-0000-4000-8000-0000000000b1', '24500000-0000-4000-8000-00000000000b', 'r2450-owner-b@example.test',   'R2450 Owner B',   'owner',   true),
  ('24500000-0000-4000-8000-0000000000c1', '24500000-0000-4000-8000-00000000000c', 'r2450-owner-o@example.test',   'R2450 Owner O',   'owner',   true);

insert into public.tenant_connections (a_tenant_id, b_tenant_id, a_gstin, b_gstin, status, a_scopes, b_scopes, origin) values
  ('24500000-0000-4000-8000-00000000000a', '24500000-0000-4000-8000-00000000000b', '07AAACR2450S1Z5', '07AAACR2450B1Z5',
   'accepted', array['invoices'], array['payments'], 'request');

insert into public.customers (id, tenant_id, name, gstin, linked_tenant_id) values
  ('24500000-0000-4000-8000-0000000001b0', '24500000-0000-4000-8000-00000000000a', 'R2450 Buyer',      '07AAACR2450B1Z5', '24500000-0000-4000-8000-00000000000b'),
  ('24500000-0000-4000-8000-0000000001d0', '24500000-0000-4000-8000-00000000000a', 'R2450 Walk-in Co', '07AAACR2450D1Z5', null);

-- A (to B, will be rejected), B (to B, will be accepted + credit note), N (to a customer not on the network)
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date, net_payable,
                             taxable_value, tax_amount, tax_rate, inter_state, customer_gstin, seller_gstin, line_items)
values
  ('INV-R2450-A', '24500000-0000-4000-8000-00000000000a', '24500000-0000-4000-8000-0000000001b0', 'R2450 Buyer',
   11800, 'pending', current_date, current_date + 15, 11800, 10000, 1800, 18, false, '07AAACR2450B1Z5', '07AAACR2450S1Z5',
   '[{"name": "Workspace Starter", "qty": 10, "rate": 1000, "hsn": "998315"}]'::jsonb),
  ('INV-R2450-B', '24500000-0000-4000-8000-00000000000a', '24500000-0000-4000-8000-0000000001b0', 'R2450 Buyer',
   5900, 'pending', current_date, current_date + 15, 5900, 5000, 900, 18, false, '07AAACR2450B1Z5', '07AAACR2450S1Z5',
   '[{"name": "Workspace Starter", "qty": 5, "rate": 1000, "hsn": "998315"}]'::jsonb),
  ('INV-R2450-N', '24500000-0000-4000-8000-00000000000a', '24500000-0000-4000-8000-0000000001d0', 'R2450 Walk-in Co',
   1180, 'pending', current_date, current_date + 15, 1180, 1000, 180, 18, false, '07AAACR2450D1Z5', '07AAACR2450S1Z5',
   '[{"name": "Workspace Starter", "qty": 1, "rate": 1000, "hsn": "998315"}]'::jsonb);

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

-- ── 1 + 2. pending with the buyer's name; nothing for a non-network customer; who may read ──
set local role authenticated;
do $$
declare r record; n int;
begin
  perform pg_temp.as_user('24500000-0000-4000-8000-0000000000a2');     -- S billing
  select count(*) into n from public.network_seller_document_status(array['INV-R2450-A', 'INV-R2450-N']);
  if n <> 1 then raise exception 'FAIL 1a: billing reads % rows (want 1: A only — N''s customer is not on the network)', n; end if;
  select * into r from public.network_seller_document_status(array['INV-R2450-A']);
  if r.kind <> 'invoice' or r.status <> 'pending' or r.buyer_name <> 'R2450 Buyer' or r.seller_invoice_id <> 'INV-R2450-A'
     or r.doc_number <> 'INV-R2450-A' or r.seller_note_id is not null then
    raise exception 'FAIL 1b: % % % % % %', r.kind, r.status, r.buyer_name, r.seller_invoice_id, r.doc_number, r.seller_note_id;
  end if;
  select count(*) into n from public.network_seller_document_status(array['INV-R2450-N']);
  if n <> 0 then raise exception 'FAIL 1c: a non-network customer''s invoice reads % rows (want none)', n; end if;

  perform pg_temp.as_user('24500000-0000-4000-8000-0000000000a1');     -- S owner
  select count(*) into n from public.network_seller_document_status(array['INV-R2450-A', 'INV-R2450-B']);
  if n <> 2 then raise exception 'FAIL 2a: the owner reads % rows (want 2)', n; end if;

  perform pg_temp.as_user('24500000-0000-4000-8000-0000000000a3');     -- S sales
  select count(*) into n from public.network_seller_document_status(array['INV-R2450-A', 'INV-R2450-B']);
  if n <> 0 then raise exception 'FAIL 2b: a sales user reads % rows', n; end if;

  perform pg_temp.as_user('24500000-0000-4000-8000-0000000000c1');     -- another company, same ids
  select count(*) into n from public.network_seller_document_status(array['INV-R2450-A', 'INV-R2450-B']);
  if n <> 0 then raise exception 'FAIL 2c: another company reads % of the seller''s rows', n; end if;

  perform pg_temp.as_user('24500000-0000-4000-8000-0000000000b1');     -- the BUYER, seller's ids
  select count(*) into n from public.network_seller_document_status(array['INV-R2450-A', 'INV-R2450-B']);
  if n <> 0 then raise exception 'FAIL 2d: the buyer reads % rows of the seller-side status', n; end if;

  select count(*) into n from public.network_seller_document_status(null);
  if n <> 0 then raise exception 'FAIL 2e: null ids read % rows', n; end if;
end $$;
reset role;

do $$
begin
  if has_function_privilege('anon', 'public.network_seller_document_status(text[])', 'execute') then
    raise exception 'FAIL 2f: anon may execute network_seller_document_status';
  end if;
  if not exists (select 1 from pg_proc where proname = 'network_seller_document_status' and prosecdef
                  and proconfig::text like '%search_path=public%' and provolatile = 's') then
    raise exception 'FAIL 2g: not a stable SECURITY DEFINER with search_path=public';
  end if;
end $$;

-- ── 3. reject → reason; accept → accepted + when ─────────────────────────────────────
set local role authenticated;
do $$
declare v_a uuid; v_b uuid; r record;
begin
  perform pg_temp.as_user('24500000-0000-4000-8000-0000000000b1');
  select id into v_a from public.network_inbox() where doc_number = 'INV-R2450-A';
  select id into v_b from public.network_inbox() where doc_number = 'INV-R2450-B';
  perform public.network_reject_document(v_a, 'Wrong quantity — we ordered 8');
  perform public.network_accept_document(v_b);

  perform pg_temp.as_user('24500000-0000-4000-8000-0000000000a2');     -- S billing
  select * into r from public.network_seller_document_status(array['INV-R2450-A']);
  if r.status <> 'rejected' or r.reject_reason <> 'Wrong quantity — we ordered 8' then
    raise exception 'FAIL 3a: rejected reads % / %', r.status, r.reject_reason;
  end if;
  select * into r from public.network_seller_document_status(array['INV-R2450-B']);
  if r.status <> 'accepted' or r.responded_at is null then
    raise exception 'FAIL 3b: accepted reads % / %', r.status, r.responded_at;
  end if;
end $$;
reset role;

-- ── 4. a credit note on the accepted invoice comes back under the invoice id ─────────
insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, customer_name, amount, taxable_value, tax_amount, tax_rate, inter_state)
values ('CN-R2450-1', '24500000-0000-4000-8000-00000000000a', 'INV-R2450-B', '24500000-0000-4000-8000-0000000001b0', 'R2450 Buyer',
        1180, 1000, 180, 18, false);
set local role authenticated;
do $$
declare r record; n int;
begin
  perform pg_temp.as_user('24500000-0000-4000-8000-0000000000a1');
  select count(*) into n from public.network_seller_document_status(array['INV-R2450-B']);
  if n <> 2 then raise exception 'FAIL 4a: invoice B reads % rows (want invoice + credit note)', n; end if;
  select * into r from public.network_seller_document_status(array['INV-R2450-B']) where kind = 'credit_note';
  if r.seller_note_id <> 'CN-R2450-1' or r.status <> 'pending' or r.seller_invoice_id <> 'INV-R2450-B' then
    raise exception 'FAIL 4b: credit note row % % %', r.seller_note_id, r.status, r.seller_invoice_id;
  end if;
end $$;

-- ── 5. a page, not the whole book ────────────────────────────────────────────────────
do $$
declare v_ids text[];
begin
  perform pg_temp.as_user('24500000-0000-4000-8000-0000000000a1');
  select array_agg('INV-' || g) into v_ids from generate_series(1, 501) g;
  begin
    perform count(*) from public.network_seller_document_status(v_ids);
    raise exception 'FAIL 5a: 501 ids were accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if position('500' in sqlerrm) = 0 then raise exception 'FAIL 5b: wrong refusal: %', sqlerrm; end if;
  end;
end $$;
reset role;

select set_config('request.jwt.claims', '', true);
select 'R-2450 network seller status: all checks passed' as result;

rollback;
