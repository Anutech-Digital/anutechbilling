\set ON_ERROR_STOP on
-- R-2895 (17 Nov 2026): the owner-delegated data repair — an OLD part proforma still waiting for money says
-- "Payment for …" instead of "Advance payment for …" (migration 20261117050700_r2895_relabel_old_part_proformas).
-- Self-asserting, ONE transaction, rolled back, synthetic company (the repair functions also see the local data —
-- it is rolled back with everything else). Safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2895_relabel.test.sql
--
-- Expect "PASS r2895_relabel".
--   PLAN       unpaid / open part proformas → 'change'; paid, part-paid, invoiced, cancelled, closed → their own
--              verdict; a "Payment for …" product line, "Advance payment for services" and a non-part quote → untouched
--   DRY        p_apply = false writes nothing
--   APPLY      only name / description of the lines (and the notes lead) change — every other column of every quote
--              (amount, subtotal, tax, seats, dates, ids, links, status, updated_at) and every other key of every
--              line is identical; the log holds old → new, who, when
--   NOTES      p_notes = false leaves notes as they are
--   IDEMPOTENT a second run changes 0 rows
--   EXPECT     a row that became paid since the report → the run raises, nothing changes
--   UNDO       r2895_undo(run) puts the old text back, byte for byte; a second undo changes nothing
--   GRANTS     no r2895 function is executable by anon / authenticated

begin;

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('b2895000-0000-0000-0000-0000000000f1', 'R2895 Relabel Co', 'r2895@example.test', '07', 'R895');

create function pg_temp.cust(p_n int) returns uuid language plpgsql as $f$
declare v_c uuid := ('b2895000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, country)
  values (v_c, 'b2895000-0000-0000-0000-0000000000f1', 'R2895 C' || p_n, '07', 'India');
  return v_c;
end $f$;

/* One subscription + one billing part (index 1, monthly) → the billing id. */
create function pg_temp.part(p_n int, p_c uuid) returns uuid language plpgsql as $f$
declare
  v_s uuid := ('b2895000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
  v_b uuid := ('b2895000-0000-0000-0000-0000000003' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status, domain)
  values (v_s, 'b2895000-0000-0000-0000-0000000000f1', p_c, (select name from public.customers where id = p_c), 'Google Workspace Business Starter',
          'google'::vendor, 10, 1000, 'monthly'::billing_cycle, 12, '2026-11-01', '2027-11-01', 'grace_period', 0, 'active',
          'r2895-' || p_n || '.example.test');
  insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start,
                                            period_end, taxable_amount, tax_rate)
  values (v_b, 'b2895000-0000-0000-0000-0000000000f1', v_s, '2026-11-01', 1, '2026-11-01', '2026-11-01', '2026-12-01', 4500, 18);
  return v_b;
end $f$;

/* A part proforma as bill_subscription_instalment made it BEFORE R-2865: the line carries the label in `description`
   (newer: R-2423) or in `name` (the oldest), notes lead with it. p_n is its number. */
create function pg_temp.pi(p_n int, p_billing uuid, p_c uuid, p_status text, p_pay text, p_lines jsonb, p_notes text)
returns text language plpgsql as $f$
declare v_id text := 'PI-R2895-' || lpad(p_n::text, 3, '0');
begin
  insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
                             domain, created_date, expires_date, line_items, subtotal, total_cost, discount_pct, tax_rate,
                             is_one_off, billing_cycle, payment_terms_days, notes, subscription_billing_id)
  values (v_id, 'b2895000-0000-0000-0000-0000000000f1', p_c, (select name from public.customers where id = p_c),
          'Google Workspace Business Starter', 10, 5310, p_status::quote_status, p_pay::payment_status,
          'r2895-' || p_n || '.example.test', '2026-11-01', null, p_lines, 4500, 0, 0, 18,
          true, 'yearly', 0, p_notes, p_billing);
  return v_id;
end $f$;

create temp table t_lbl (k text primary key, q text) on commit drop;

do $$
declare
  v_c uuid; b uuid; v_q text;
  v_desc  constant text := 'Advance payment for month 1 · 1 Nov–30 Nov 2026';
  v_notes constant text := 'Advance payment for month 1 · 1 Nov–30 Nov 2026. Due on 1 Nov 2026. The tax invoice is issued when this is paid.';
  v_line  constant jsonb := jsonb_build_array(jsonb_build_object(
    'id', 'part-1', 'name', 'Google Workspace Business Starter · r2895.example.test · 10 seats · 1 Nov–30 Nov 2026 (part 1 of 12)',
    'description', v_desc, 'qty', 10, 'rate', 450, 'per_seat', true, 'period_start', '2026-11-01', 'period_end', '2026-11-30',
    'cost', 0, 'one_time', true));
begin
  -- U1: unpaid, newer shape (label in description + notes)
  v_c := pg_temp.cust(1); b := pg_temp.part(1, v_c);
  insert into t_lbl values ('U1', pg_temp.pi(1, b, v_c, 'sent', 'awaiting', v_line, v_notes));
  -- U2: unpaid, oldest shape (label in the line NAME, no description), two lines (a group), quarterly label, viewed, 'none'
  v_c := pg_temp.cust(2); b := pg_temp.part(2, v_c);
  insert into t_lbl values ('U2', pg_temp.pi(2, b, v_c, 'viewed', 'none',
    jsonb_build_array(
      jsonb_build_object('id', 'part-2-1', 'name', 'Advance payment for Q2 · 28 Jan–27 Apr 2027', 'qty', 1, 'rate', 3000, 'cost', 0, 'one_time', true, 'billing_id', b::text),
      jsonb_build_object('id', 'part-2-2', 'name', 'Starter · b.in · 5 seats', 'description', 'Advance payment for Q2 · 28 Jan–27 Apr 2027', 'qty', 5, 'rate', 300, 'cost', 0, 'one_time', true)),
    null));
  -- P: paid in full, PP: part-paid, I: invoiced, R: received payment row only, C: cancelled, X: rejected, A: accepted + awaiting (still unpaid)
  v_c := pg_temp.cust(3); b := pg_temp.part(3, v_c);
  insert into t_lbl values ('P', pg_temp.pi(3, b, v_c, 'accepted', 'received', v_line, v_notes));
  v_c := pg_temp.cust(4); b := pg_temp.part(4, v_c);
  insert into t_lbl values ('PP', pg_temp.pi(4, b, v_c, 'accepted', 'partial', v_line, v_notes));
  v_c := pg_temp.cust(5); b := pg_temp.part(5, v_c);
  insert into t_lbl values ('I', pg_temp.pi(5, b, v_c, 'accepted', 'invoiced', v_line, v_notes));
  v_c := pg_temp.cust(6); b := pg_temp.part(6, v_c);
  v_q := pg_temp.pi(6, b, v_c, 'sent', 'awaiting', v_line, v_notes);
  -- a cancelled proforma let go of its part: link moved to cancelled_part_billing_id
  update public.quotes set subscription_billing_id = null, cancelled_part_billing_id = b, cancelled_at = now(),
         cancel_reason = 'test' where id = v_q;
  insert into t_lbl values ('C', v_q);
  v_c := pg_temp.cust(7); b := pg_temp.part(7, v_c);
  insert into t_lbl values ('X', pg_temp.pi(7, b, v_c, 'rejected', 'none', v_line, v_notes));
  v_c := pg_temp.cust(8); b := pg_temp.part(8, v_c);
  insert into t_lbl values ('A', pg_temp.pi(8, b, v_c, 'accepted', 'awaiting', v_line, v_notes));
  -- N1: a part proforma whose product line is literally named "Payment for month 3 hosting" (not "Advance …"): untouched
  v_c := pg_temp.cust(9); b := pg_temp.part(9, v_c);
  insert into t_lbl values ('N1', pg_temp.pi(9, b, v_c, 'sent', 'awaiting',
    jsonb_build_array(jsonb_build_object('id', 'part-9', 'name', 'Payment for month 3 hosting', 'description', 'Payment for month 3 hosting', 'qty', 1, 'rate', 4500, 'cost', 0)), 'Payment for month 3 hosting. Due soon.'));
  -- N2: "Advance payment for services" (not the label's shape): reported, untouched
  v_c := pg_temp.cust(10); b := pg_temp.part(10, v_c);
  insert into t_lbl values ('N2', pg_temp.pi(10, b, v_c, 'sent', 'awaiting',
    jsonb_build_array(jsonb_build_object('id', 'part-10', 'name', 'Advance payment for services', 'description', 'Advance payment for services', 'qty', 1, 'rate', 4500, 'cost', 0)), 'Advance payment for services. Thanks.'));
  -- N3: not a part request at all (a sales quote with a product named so): untouched
  v_c := pg_temp.cust(11);
  insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status, created_date,
                             line_items, subtotal, total_cost, discount_pct, tax_rate, notes)
  values ('Q-R2895-N3', 'b2895000-0000-0000-0000-0000000000f1', v_c, 'R2895 C11', 'Custom', 1, 5310, 'sent', 'awaiting', '2026-11-01',
          jsonb_build_array(jsonb_build_object('id', 'x', 'name', 'Advance payment for month 1 · setup', 'qty', 1, 'rate', 4500, 'cost', 0)),
          4500, 0, 0, 18, 'Advance payment for month 1 · setup');
  insert into t_lbl values ('N3', 'Q-R2895-N3');
end $$;

-- before snapshot of every one of my quotes (everything except line_items + notes) and of the line keys
create temp table t_before on commit drop as
  select q.id, to_jsonb(q) - 'line_items' - 'notes' as rowx, q.line_items, q.notes
    from public.quotes q where q.tenant_id = 'b2895000-0000-0000-0000-0000000000f1';

do $$
declare
  v_fails text[] := '{}';
  r jsonb; r2 jsonb; v_run uuid; v_n int; v_k text; v_tot int;
  v_expect_ids text[] := array['U1', 'U2', 'A'];
begin
  -- ── PLAN ──────────────────────────────────────────────────────────────
  if (select count(*) from public.r2895_plan() p join t_lbl l on l.q = p.quote_id where l.k in ('U1','U2','A') and p.verdict = 'change') <> 3 then
    v_fails := v_fails || 'PLAN: U1 / U2 / A should be change';
  end if;
  if (select p.verdict from public.r2895_plan() p join t_lbl l on l.q = p.quote_id where l.k = 'P')  <> 'paid' then v_fails := v_fails || 'PLAN: P not paid'; end if;
  if (select p.verdict from public.r2895_plan() p join t_lbl l on l.q = p.quote_id where l.k = 'PP') <> 'paid' then v_fails := v_fails || 'PLAN: PP not paid'; end if;
  if (select p.verdict from public.r2895_plan() p join t_lbl l on l.q = p.quote_id where l.k = 'I')  <> 'invoiced' then v_fails := v_fails || 'PLAN: I not invoiced'; end if;
  if (select p.verdict from public.r2895_plan() p join t_lbl l on l.q = p.quote_id where l.k = 'C')  <> 'cancelled' then v_fails := v_fails || 'PLAN: C not cancelled'; end if;
  if (select p.verdict from public.r2895_plan() p join t_lbl l on l.q = p.quote_id where l.k = 'X')  <> 'closed' then v_fails := v_fails || 'PLAN: X not closed'; end if;
  if (select p.verdict from public.r2895_plan() p join t_lbl l on l.q = p.quote_id where l.k = 'N2') <> 'label_shape_unrecognised' then v_fails := v_fails || 'PLAN: N2 not label_shape_unrecognised'; end if;
  if (select p.verdict from public.r2895_plan() p join t_lbl l on l.q = p.quote_id where l.k = 'N3') <> 'not_a_part_request' then v_fails := v_fails || 'PLAN: N3 not not_a_part_request'; end if;
  if exists (select 1 from public.r2895_plan() p join t_lbl l on l.q = p.quote_id where l.k = 'N1') then v_fails := v_fails || 'PLAN: N1 (Payment for … product) listed'; end if;
  -- the label text in the plan
  if (select p.old_text from public.r2895_plan() p join t_lbl l on l.q = p.quote_id where l.k = 'U1') <> 'Advance payment for month 1 · 1 Nov–30 Nov 2026'
     or (select p.new_text from public.r2895_plan() p join t_lbl l on l.q = p.quote_id where l.k = 'U1') <> 'Payment for month 1 · 1 Nov–30 Nov 2026' then
    v_fails := v_fails || 'PLAN: U1 old / new text';
  end if;

  -- ── DRY ───────────────────────────────────────────────────────────────
  r := public.r2895_repair(false);
  if (r->>'applied')::boolean or (r->>'changed')::int <> 0 or r->>'run_id' is not null then v_fails := v_fails || 'DRY: reported a change'; end if;
  if exists (select 1 from t_before b join public.quotes q on q.id = b.id where q.line_items is distinct from b.line_items or q.notes is distinct from b.notes) then
    v_fails := v_fails || 'DRY: wrote';
  end if;

  -- ── EXPECT: a wrong expected count refuses, nothing changes ─────────────
  select count(*) into v_tot from public.r2895_plan() where verdict = 'change';
  begin
    perform public.r2895_repair(true, v_tot + 1);
    v_fails := v_fails || 'EXPECT: wrong count did not raise';
  exception when others then
    if sqlerrm not like 'R-2895: the report said%' then v_fails := v_fails || ('EXPECT: other error ' || sqlerrm); end if;
  end;
  if exists (select 1 from t_before b join public.quotes q on q.id = b.id where q.line_items is distinct from b.line_items or q.notes is distinct from b.notes) then
    v_fails := v_fails || 'EXPECT: wrote after refusing';
  end if;

  -- ── APPLY ─────────────────────────────────────────────────────────────
  r := public.r2895_repair(true, v_tot);
  v_run := (r->>'run_id')::uuid;
  if (r->>'changed')::int <> v_tot then v_fails := v_fails || ('APPLY: changed ' || (r->>'changed') || ' of ' || v_tot); end if;
  if (select count(*) from public.r2895_repair_log g where g.run_id = v_run and g.tenant_id = 'b2895000-0000-0000-0000-0000000000f1') <> 3 then
    v_fails := v_fails || 'APPLY: log should hold U1, U2, A';
  end if;
  if exists (select 1 from public.r2895_repair_log g where g.run_id = v_run and (g.applied_by is null or g.applied_at is null or g.before_lines = g.after_lines)) then
    v_fails := v_fails || 'APPLY: log row without who / when / change';
  end if;
  -- every column but line_items + notes identical on EVERY quote of the company (updated_at too)
  if exists (select 1 from t_before b join public.quotes q on q.id = b.id where (to_jsonb(q) - 'line_items' - 'notes') is distinct from b.rowx) then
    v_fails := v_fails || 'APPLY: a column other than line_items / notes changed';
  end if;
  -- unchanged rows keep their lines and notes exactly
  if exists (select 1 from t_before b join public.quotes q on q.id = b.id join t_lbl l on l.q = q.id
              where l.k not in ('U1', 'U2', 'A') and (q.line_items is distinct from b.line_items or q.notes is distinct from b.notes)) then
    v_fails := v_fails || 'APPLY: a paid / invoiced / cancelled / closed / not-a-label row changed';
  end if;
  -- changed rows: per line only name / description differ; same line count; text now reads Payment for
  if exists (
    select 1 from t_before b join public.quotes q on q.id = b.id join t_lbl l on l.q = q.id
     where l.k in ('U1', 'U2', 'A')
       and (jsonb_array_length(q.line_items) <> jsonb_array_length(b.line_items)
            or exists (select 1 from jsonb_array_elements(b.line_items) with ordinality o(x, i)
                         join jsonb_array_elements(q.line_items) with ordinality n(x, i) using (i)
                        where (o.x - 'name' - 'description') is distinct from (n.x - 'name' - 'description'))
            or q.line_items::text like '%Advance payment for%' or coalesce(q.notes, '') like 'Advance payment for%')
  ) then v_fails := v_fails || 'APPLY: lines differ beyond name / description, or old text left'; end if;
  if (select q.line_items->0->>'description' from public.quotes q join t_lbl l on l.q = q.id where l.k = 'U1') <> 'Payment for month 1 · 1 Nov–30 Nov 2026'
     or (select q.notes from public.quotes q join t_lbl l on l.q = q.id where l.k = 'U1') <> 'Payment for month 1 · 1 Nov–30 Nov 2026. Due on 1 Nov 2026. The tax invoice is issued when this is paid.'
     or (select q.line_items->0->>'name' from public.quotes q join t_lbl l on l.q = q.id where l.k = 'U1') <> 'Google Workspace Business Starter · r2895.example.test · 10 seats · 1 Nov–30 Nov 2026 (part 1 of 12)' then
    v_fails := v_fails || 'APPLY: U1 text';
  end if;
  if (select q.line_items->0->>'name' from public.quotes q join t_lbl l on l.q = q.id where l.k = 'U2') <> 'Payment for Q2 · 28 Jan–27 Apr 2027'
     or (select q.line_items->1->>'description' from public.quotes q join t_lbl l on l.q = q.id where l.k = 'U2') <> 'Payment for Q2 · 28 Jan–27 Apr 2027'
     or (select q.line_items->1->>'name' from public.quotes q join t_lbl l on l.q = q.id where l.k = 'U2') <> 'Starter · b.in · 5 seats' then
    v_fails := v_fails || 'APPLY: U2 text (name-label line, description-label line, product name kept)';
  end if;
  if current_setting('app.r2895_repair', true) not in ('', 'off') then v_fails := v_fails || 'APPLY: flag left on'; end if;

  -- ── IDEMPOTENT ────────────────────────────────────────────────────────
  r2 := public.r2895_repair(true);
  if (r2->>'changed')::int <> 0 then v_fails := v_fails || ('IDEMPOTENT: second run changed ' || (r2->>'changed')); end if;

  -- ── UNDO ──────────────────────────────────────────────────────────────
  r2 := public.r2895_undo(v_run);
  if (r2->>'undone')::int <> v_tot or (r2->>'changed_since_left')::int <> 0 then v_fails := v_fails || ('UNDO: ' || r2::text); end if;
  if exists (select 1 from t_before b join public.quotes q on q.id = b.id
              where q.line_items is distinct from b.line_items or q.notes is distinct from b.notes
                 or (to_jsonb(q) - 'line_items' - 'notes') is distinct from b.rowx) then
    v_fails := v_fails || 'UNDO: a quote is not exactly as before';
  end if;
  r2 := public.r2895_undo(v_run);
  if (r2->>'undone')::int <> 0 then v_fails := v_fails || 'UNDO: second undo changed rows'; end if;

  -- ── NOTES switch: p_notes = false leaves the notes lead as it is ──────────
  r := public.r2895_repair(true, null, false);
  if (select q.notes from public.quotes q join t_lbl l on l.q = q.id where l.k = 'U1') <> (select b.notes from t_before b join t_lbl l on l.q = b.id where l.k = 'U1')
     or (select q.line_items->0->>'description' from public.quotes q join t_lbl l on l.q = q.id where l.k = 'U1') <> 'Payment for month 1 · 1 Nov–30 Nov 2026' then
    v_fails := v_fails || 'NOTES: p_notes=false changed the notes or skipped the line';
  end if;
  perform public.r2895_undo((r->>'run_id')::uuid);

  -- ── SINCE THE REPORT: a row becomes paid → the guarded run raises, nothing is kept ───────────────
  select count(*) into v_tot from public.r2895_plan() where verdict = 'change';
  update public.quotes set payment_status = 'received' where id = (select q from t_lbl where k = 'A');
  begin
    perform public.r2895_repair(true, v_tot);
    v_fails := v_fails || 'SINCE: ran although a row became paid';
  exception when others then
    if sqlerrm not like 'R-2895: the report said%' then v_fails := v_fails || ('SINCE: other error ' || sqlerrm); end if;
  end;
  if (select q.line_items::text like '%Advance payment for%' from public.quotes q join t_lbl l on l.q = q.id where l.k = 'A') is not true then
    v_fails := v_fails || 'SINCE: the paid row was relabelled';
  end if;

  -- ── GRANTS ────────────────────────────────────────────────────────────
  for v_k in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'r2895\_%' or p.proname = 'tg_r2895_keep_updated_at') loop
    if has_function_privilege('anon', v_k::regprocedure, 'execute') or has_function_privilege('authenticated', v_k::regprocedure, 'execute') then
      v_fails := v_fails || ('GRANTS: executable by anon / authenticated: ' || v_k);
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.r2895_repair_log', 'insert') or has_table_privilege('authenticated', 'public.r2895_repair_log', 'update')
     or has_table_privilege('authenticated', 'public.r2895_repair_log', 'delete') or has_table_privilege('anon', 'public.r2895_repair_log', 'select') then
    v_fails := v_fails || 'GRANTS: r2895_repair_log writable / readable by a request login';
  end if;

  if array_length(v_fails, 1) > 0 then
    raise exception 'FAIL r2895_relabel: %', array_to_string(v_fails, ' | ');
  end if;
  raise notice 'PASS r2895_relabel';
end $$;

rollback;
