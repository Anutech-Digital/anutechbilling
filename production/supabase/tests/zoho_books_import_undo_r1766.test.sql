-- R-1766 — "Undo import" of a real-size Zoho Books import stays well under the 8 s timeout
-- (migration 20261022143646_r1766_zoho_undo_small_parts).
--
-- Self-asserting: RAISEs on failure. One transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/zoho_books_import_undo_r1766.test.sql
--
-- The owner's case (localhost, 22 Oct): the real import (1,245 customers / 1,371 subscriptions)
-- was undone in calls of 8.5–10.6 s, one 15.3 s → statement timeout at 126 of 1,376
-- subscriptions; a second press finished it. Made-up T- data at that size: 1,300 customers each
-- with a contact person (half with a GSTIN), 1,400 subscriptions with R-1763's Zoho invoice
-- columns (a quarter monthly), 250 open invoices.
--
-- What it proves:
--   1. Import parts (re-measured on this data) each stay far under the timeout.
--   2. Every undo call that is not the last stops near 1.5 s (R-1760's ran to 2.5 s and then
--      one more 250-row part — over 2.5 s every time); no call reaches 3 s.
--   3. Each answer says how many there are in all (subscriptions_total / customers_total).
--   4. Everything is removed, and every removed customer / subscription still has its own
--      activity-log line (the audit trail is not thinned); one "import undone" line at the end.

begin;

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1766000-0000-0000-0000-0000000000a1'::uuid, 'T-R1766 A', 'r1766-a@example.in', '07', 'TRM');
insert into auth.users (id, email) values ('c1766000-0000-0000-0000-00000000a0a1', 'r1766-owner-a@example.test');
insert into public.users (id, tenant_id, email, role, full_name) values
  ('c1766000-0000-0000-0000-00000000a0a1', 'c1766000-0000-0000-0000-0000000000a1', 'r1766-owner-a@example.in', 'owner', 'Owner A');
insert into public.zoho_books_import_runs (id, tenant_id, org_id, since, phase, scanned_at) values
  ('c1766000-0000-0000-0000-0000000f0001', 'c1766000-0000-0000-0000-0000000000a1', '60000066', '2024-10-22', 'ready', now());

create temp table r1766_payload (k text primary key, v jsonb);
grant all on r1766_payload to authenticated;
insert into r1766_payload select 'customers', (select jsonb_agg(jsonb_build_object(
  'zoho_id', 'z-' || g, 'name', 'T-R1766 Customer ' || g,
  'gstin', case when g % 2 = 0 then '07AAAC' || lpad(g::text, 4, '0') || 'A1Z' || (g % 10) end,
  'gst_treatment', case when g % 2 = 0 then 'registered_regular' end, 'state', 'Delhi', 'state_code', '07',
  'payment_terms_days', 15, 'customer_type', 'business',
  'contact_name', 'T-Person ' || g, 'contact_email', 't-person' || g || '@r1766.example', 'contact_phone', '90000' || lpad(g::text, 5, '0'),
  'since', '2025-04-01') order by g) from generate_series(1, 1300) g);
insert into r1766_payload select 'subscriptions', (select jsonb_agg(jsonb_build_object(
  'zoho_customer_id', 'z-' || (1 + (g - 1) % 1300), 'customer_name', 'x',
  'plan', case when g % 3 = 0 then 'Microsoft 365 Business Basic' else 'Google Workspace Business Starter' end,
  'vendor', case when g % 3 = 0 then 'microsoft' else 'google' end, 'seats', 5, 'mrr', 750,
  'start_date', case when g % 4 = 0 then '2026-10-01' else '2025-04-01' end,
  'renewal_date', case when g % 4 = 0 then '2026-10-31' else '2027-03-31' end,
  'domain', 't-r1766-' || g || '.in', 'billing_cycle', case when g % 4 = 0 then 'monthly' else 'yearly' end,
  'term_months', case when g % 4 = 0 then 1 else 12 end,
  'source_invoice', 'INV-T-' || g, 'source_invoice_date', '2026-06-22', 'prorata_seats', 0, 'from_service_expiry', false) order by g)
  from generate_series(1, 1400) g);
insert into r1766_payload select 'invoices', (select jsonb_agg(jsonb_build_object(
  'number', 'INV-T1766-' || g, 'invoice_date', '2026-01-10', 'due_date', '2026-01-25', 'zoho_customer_id', 'z-' || g,
  'total', 1180, 'balance', 1000, 'currency', 'INR', 'gstin', null, 'pos_state_code', '07') order by g)
  from generate_series(1, 250) g);

set local role authenticated;

-- ── 1. Import, part by part, each part timed ─────────────────────────────────────────────
do $$
declare v jsonb; v_t0 timestamptz; v_ms numeric; v_max numeric := 0; v_n int := 0;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1766000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  v := public.zoho_books_import_begin('c1766000-0000-0000-0000-0000000f0001',
         (select p.v from r1766_payload p where k = 'customers'),
         (select p.v from r1766_payload p where k = 'subscriptions'),
         (select p.v from r1766_payload p where k = 'invoices'));
  loop
    v_t0 := clock_timestamp();
    v := public.zoho_books_import_step('c1766000-0000-0000-0000-0000000f0001', 150);
    v_ms := extract(epoch from clock_timestamp() - v_t0) * 1000;
    v_max := greatest(v_max, v_ms);
    v_n := v_n + 1;
    exit when (v->>'done')::boolean or v_n > 60;
  end loop;
  if not (v->>'done')::boolean then raise exception 'FAIL 1a: import never finished: %', v; end if;
  if (v->'result'->>'customers_created')::int <> 1300 or (v->'result'->>'subscriptions_created')::int <> 1400
     or (v->'result'->>'invoices_imported')::int <> 250 then
    raise exception 'FAIL 1b: import result %', v->'result';
  end if;
  if v_max > 3000 then raise exception 'FAIL 1c: an import part took % ms', round(v_max); end if;
  raise notice 'PASS 1: import of 1,300 / 1,400 / 250 in % parts, slowest % ms', v_n, round(v_max);
end $$;

-- ── 2–4. Undo, each call timed ───────────────────────────────────────────────────────────
do $$
declare v jsonb; v_t0 timestamptz; v_ms numeric; v_max numeric := 0; v_max_mid numeric := 0; v_calls int := 0;
        v_times text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1766000-0000-0000-0000-00000000a0a1', 'role', 'authenticated')::text, true);
  loop
    v_calls := v_calls + 1;
    v_t0 := clock_timestamp();
    v := public.zoho_books_import_undo('c1766000-0000-0000-0000-0000000f0001', 'T-wrong org');
    v_ms := extract(epoch from clock_timestamp() - v_t0) * 1000;
    v_times := v_times || round(v_ms) || ' ';
    v_max := greatest(v_max, v_ms);
    if not (v->>'done')::boolean then v_max_mid := greatest(v_max_mid, v_ms); end if;
    if (v->>'subscriptions_total') is distinct from '1400' or (v->>'customers_total') is distinct from '1300' then
      raise exception 'FAIL 3: undo answer has no totals: %', v;
    end if;
    exit when (v->>'done')::boolean or v_calls > 40;
  end loop;
  raise notice 'undo calls (ms): %', v_times;
  if not (v->>'done')::boolean then raise exception 'FAIL 2a: undo never finished: %', v; end if;
  if v_max_mid > 2500 then
    raise exception 'FAIL 2b: an undo call that was not the last took % ms — it must stop near 1.5 s', round(v_max_mid);
  end if;
  if v_max > 3000 then raise exception 'FAIL 2c: an undo call took % ms (want < 3,000; the timeout is 8,000)', round(v_max); end if;
  raise notice 'PASS 2+3: undo in % calls, slowest % ms (not-last slowest % ms); totals 1,400 / 1,300 on every answer',
    v_calls, round(v_max), round(v_max_mid);

  if (v->>'customers_removed')::int <> 1300 or (v->>'subscriptions_removed')::int <> 1400 or (v->>'invoices_removed')::int <> 250 then
    raise exception 'FAIL 4a: undo result %', v;
  end if;
  if exists (select 1 from public.customers where tenant_id = 'c1766000-0000-0000-0000-0000000000a1')
     or exists (select 1 from public.subscriptions where tenant_id = 'c1766000-0000-0000-0000-0000000000a1')
     or exists (select 1 from public.invoices where tenant_id = 'c1766000-0000-0000-0000-0000000000a1')
     or exists (select 1 from public.contacts where tenant_id = 'c1766000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 4b: undo left rows behind';
  end if;
end $$;

reset role;
do $$
declare v_s int; v_c int; v_u int;
begin
  select count(*) filter (where entity = 'subscriptions' and action = 'delete'),
         count(*) filter (where entity = 'customers' and action = 'delete'),
         count(*) filter (where action = 'zoho_books.import_undone')
    into v_s, v_c, v_u
    from public.activity_log
   where tenant_id = 'c1766000-0000-0000-0000-0000000000a1';
  if v_s <> 1400 or v_c <> 1300 or v_u <> 1 then
    raise exception 'FAIL 4c: activity log has % subscription / % customer delete lines and % undo lines (want 1,400 / 1,300 / 1)', v_s, v_c, v_u;
  end if;
  raise notice 'PASS 4: all removed; every removed customer and subscription has its activity-log line; one undo line';
end $$;

rollback;
