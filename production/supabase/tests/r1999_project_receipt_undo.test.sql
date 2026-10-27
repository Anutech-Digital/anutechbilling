-- R-1999 (27 Oct 2026, G-RECON) — undo a wrong project-receipt match in ONE place.
-- Source: R-1910 audit case 8 (drafts/R-1910/c8_wrong_match_undo.sql). Decision D3 (Pardeep, 26 Oct):
-- the invoice a wrong match raised STAYS (no credit note — the GST series is never broken); only the
-- payments go, and the invoice shows as due again.
--
-- Owner's path: Banking → a line booked to the wrong project → Un-reconcile → the dialog lists, per
-- kist, what goes back (project_receipt_undo_preview) → confirm (unreconcile_bank_receipt).
--
--   1. c8: ₹1,18,000 booked to the WRONG project, its invoice raised → un-reconcile: payment gone, kist
--      back to Invoiced, the invoice stays (no credit note) and is due again, Undeposited funds 0;
--      re-booked to the right project: cash + undeposited = the one ₹1,18,000, GL balanced.
--   2. A 2-kist allocation (allocate_project_receipt, R-1995): the preview lists both kists with
--      before / after and changes nothing; un-reconcile takes BOTH payments back (was: only the
--      first was even seen), both invoices stay, due again; the line is free.
--   3. With TDS (allocate_project_receipt_with_tds, R-1996): the TDS payments (method 'tds') and the
--      TDS receivable rows go too — TDS receivable back where it was; re-booking the same line to
--      the right project does not double count and the GL is balanced.
--   4. Refused with a link, nothing changed: a TDS row whose certificate is already in; a billing
--      user (may not remove payments). The preview shows the same refusal.
--   5. "Undo sale" (p_undo_sale = true) on a project line does the same one-place undo (c8 part 2).
--   6. The preview refuses a line that is not a project payment.
-- Fails before 20261027012329_r1999_project_receipt_undo (the payment stays; preview does not exist).
begin;

create function pg_temp.r1999_fill_supplier() returns trigger language plpgsql as $r$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, Delhi');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $r$;
create trigger zz_r1999_supplier before insert on public.tenants
  for each row execute function pg_temp.r1999_fill_supplier();

insert into public.tenants (id, name, email, state_code) values
  ('f1999000-0000-4000-8000-000000000001', 'R1999 TEST CO', 'r1999@test.invalid', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('f1999000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1999-owner@test.invalid'),
  ('f1999000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1999-billing@test.invalid');
insert into public.users (id, tenant_id, email, role) values
  ('f1999000-0000-4000-8000-0000000000a1', 'f1999000-0000-4000-8000-000000000001', 'r1999-owner@test.invalid', 'owner'),
  ('f1999000-0000-4000-8000-0000000000a2', 'f1999000-0000-4000-8000-000000000001', 'r1999-billing@test.invalid', 'billing');
insert into public.customers (id, tenant_id, name, state_code) values
  ('f1999000-0000-4000-8000-0000000000c1', 'f1999000-0000-4000-8000-000000000001', 'R1999 Demo Client', '07'),
  ('f1999000-0000-4000-8000-0000000000c2', 'f1999000-0000-4000-8000-000000000001', 'R1999 Other Client', '07');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('f1999000-0000-4000-8000-0000000000b1', 'f1999000-0000-4000-8000-000000000001', 'R1999 HDFC', 'HDFC', 0, '2026-04-01');

create function pg_temp.as_user(p_user text) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$f$;
select pg_temp.as_user('f1999000-0000-4000-8000-0000000000a1');

create function pg_temp.txn(p_amount int, p_date date, p_desc text) returns uuid language sql as $f$
  insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, reference, debit, credit, source)
  values ('f1999000-0000-4000-8000-000000000001', 'f1999000-0000-4000-8000-0000000000b1', p_date, p_desc,
          'UTR' || substr(md5(p_desc || p_amount), 1, 10), 0, p_amount, 'manual')
  returning id;
$f$;

-- A project sold the normal way (quotation → accepted), 18% GST, GST-inclusive milestones.
create function pg_temp.project(p_title text, p_ms int[], p_customer uuid default 'f1999000-0000-4000-8000-0000000000c1')
returns uuid language plpgsql as $f$
declare v_pid uuid; v_ms jsonb := '[]'; v_total int := 0; i int;
begin
  for i in 1 .. array_length(p_ms, 1) loop
    v_ms := v_ms || jsonb_build_array(jsonb_build_object('label', 'Kist ' || i, 'total_amount', p_ms[i],
                                                         'due_date', (date '2026-10-01' + (i - 1) * 30)));
    v_total := v_total + p_ms[i];
  end loop;
  v_pid := public.create_project_quote(p_customer, (select name from public.customers where id = p_customer),
             p_title, null, jsonb_build_array(jsonb_build_object('name', p_title, 'qty', 1,
             'rate', round(v_total * 100.0 / 118), 'amount', round(v_total * 100.0 / 118))),
             18, false, v_ms);
  perform public.accept_project_quote(v_pid);
  return v_pid;
end $f$;

create function pg_temp.ms(p_project uuid, p_seq int) returns uuid language sql as $f$
  select id from public.project_milestones where project_id = p_project and seq = p_seq;
$f$;
create function pg_temp.ms_paid(p_ms uuid) returns int language sql as $f$
  select coalesce(sum(amount), 0)::int from public.project_payments where milestone_id = p_ms;
$f$;
create function pg_temp.alloc(variadic p jsonb[]) returns jsonb language sql as $f$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from unnest(p) x;
$f$;
create function pg_temp.a(p_ms uuid, p_amount int, p_invoice boolean default true) returns jsonb language sql as $f$
  select jsonb_build_object('milestone_id', p_ms, 'amount', p_amount, 'raise_invoice', p_invoice);
$f$;
create function pg_temp.tds(p_amount numeric, p_rate numeric default 10, p_section text default '194J') returns jsonb language sql as $f$
  select jsonb_build_object('section', p_section, 'rate_pct', p_rate, 'amount', p_amount);
$f$;
create function pg_temp.inv_of(p_ms uuid) returns text language sql as $f$
  select invoice_id from public.project_milestones where id = p_ms;
$f$;

create function pg_temp.check(p_ok boolean, p_msg text) returns void language plpgsql as $f$
begin
  if not coalesce(p_ok, false) then raise exception 'R-1999 FAIL: %', p_msg; end if;
  raise notice 'ok  : %', p_msg;
end $f$;

create temp table snap (k text primary key, cash bigint, undeposited bigint, project_receivable bigint, tds bigint, advances bigint);
create function pg_temp.snap(p_k text) returns void language sql as $f$
  insert into snap
  select p_k, b.cash_and_bank, b.undeposited_funds, b.project_receivable, b.tds_receivable, b.advances_from_customers
    from public.report_balance_sheet(public.ist_today()) b
  on conflict (k) do update set cash = excluded.cash, undeposited = excluded.undeposited,
    project_receivable = excluded.project_receivable, tds = excluded.tds, advances = excluded.advances;
$f$;
-- assets added (bank + undeposited + project receivable + TDS receivable − customer advance) since snap k
create function pg_temp.net_since(p_k text) returns bigint language sql as $f$
  select (b.cash_and_bank - s.cash) + (b.undeposited_funds - s.undeposited) + (b.project_receivable - s.project_receivable)
         + (b.tds_receivable - s.tds) - (b.advances_from_customers - s.advances)
    from public.report_balance_sheet(public.ist_today()) b, snap s where s.k = p_k;
$f$;
create function pg_temp.undep_since(p_k text) returns bigint language sql as $f$
  select b.undeposited_funds - s.undeposited from public.report_balance_sheet(public.ist_today()) b, snap s where s.k = p_k;
$f$;
create function pg_temp.cash_since(p_k text) returns bigint language sql as $f$
  select b.cash_and_bank - s.cash from public.report_balance_sheet(public.ist_today()) b, snap s where s.k = p_k;
$f$;
create function pg_temp.tds_since(p_k text) returns bigint language sql as $f$
  select b.tds_receivable - s.tds from public.report_balance_sheet(public.ist_today()) b, snap s where s.k = p_k;
$f$;

-- ── 1. c8: wrong project, invoice raised → undo → re-book to the right project ─────────────────
do $$
declare v_a uuid; v_b uuid; v_ma uuid; v_mb uuid; v_t uuid; v_inv text; v_inv_b text; r jsonb; i record;
begin
  perform pg_temp.snap('c1');
  v_a  := pg_temp.project('C8 WRONG project', array[118000]);
  v_b  := pg_temp.project('C8 RIGHT project', array[118000], 'f1999000-0000-4000-8000-0000000000c2');
  v_ma := pg_temp.ms(v_a, 1); v_mb := pg_temp.ms(v_b, 1);
  v_t  := pg_temp.txn(118000, date '2026-10-14', 'NEFT-R1999 OTHER CLIENT-118000');

  -- the mistake: booked to the wrong project, invoice raised
  perform public.record_project_payment(v_ma, 118000, 'bank_transfer', 'NEFT', date '2026-10-14', v_t);
  v_inv := public.raise_project_milestone_invoice(v_ma);

  r := public.unreconcile_bank_receipt(v_t, false);
  perform pg_temp.check(pg_temp.ms_paid(v_ma) = 0, format('c1: wrong project''s payment removed (still ₹%s)', pg_temp.ms_paid(v_ma)));
  perform pg_temp.check((select status from public.project_milestones where id = v_ma) = 'invoiced',
    format('c1: wrong kist back to Invoiced (got %s)', (select status from public.project_milestones where id = v_ma)));
  select * into i from public.invoices where id = v_inv;
  perform pg_temp.check(i.id is not null and i.status::text not in ('paid', 'void', 'cancelled') and coalesce(i.paid_amount, 0) = 0 and i.paid_date is null,
    format('c1 D3: invoice %s stays, due again (status %s, paid ₹%s)', v_inv, i.status, i.paid_amount));
  perform pg_temp.check(not exists (select 1 from public.credit_notes where invoice_id = v_inv), 'c1 D3: no credit note on the invoice');
  perform pg_temp.check((select matched_to_type from public.bank_transactions where id = v_t) is null, 'c1: the bank line is free');
  perform pg_temp.check(pg_temp.undep_since('c1') = 0, format('c1 GL: no phantom Undeposited funds after undo (got %s)', pg_temp.undep_since('c1')));
  perform pg_temp.check((r->>'project_payments_removed')::int = 1 and (r->>'project_amount_removed')::int = 118000
                        and r->'invoices_due_again' ? v_inv,
    format('c1: result says 1 payment of ₹1,18,000 removed, invoice due again (%s)', r));

  -- re-book to the right project
  perform public.record_project_payment(v_mb, 118000, 'bank_transfer', 'NEFT', date '2026-10-14', v_t);
  v_inv_b := public.raise_project_milestone_invoice(v_mb);
  perform pg_temp.check(pg_temp.cash_since('c1') + pg_temp.undep_since('c1') = 118000,
    format('c1 GL: cash + undeposited = the one ₹1,18,000 received (got %s + %s)', pg_temp.cash_since('c1'), pg_temp.undep_since('c1')));
  perform pg_temp.check(pg_temp.net_since('c1') = 118000 + 118000,
    format('c1 GL balanced: assets added = invoiced (wrong invoice still due ₹1,18,000 + right one ₹1,18,000) (got %s)', pg_temp.net_since('c1')));
end $$;

-- ── 2. a 2-kist allocation (R-1995): preview, then undo takes BOTH back ───────────────────────
do $$
declare v_p uuid; v_m1 uuid; v_m2 uuid; v_t uuid; p jsonb; r jsonb; v_i1 text; v_i2 text;
begin
  perform pg_temp.snap('c2');
  v_p  := pg_temp.project('C2 App build', array[118000, 118000]);
  v_m1 := pg_temp.ms(v_p, 1); v_m2 := pg_temp.ms(v_p, 2);
  v_t  := pg_temp.txn(236000, date '2026-10-15', 'RTGS-R1999 DEMO CLIENT-KIST 1+2');
  perform public.allocate_project_receipt(v_t, v_p, pg_temp.alloc(pg_temp.a(v_m1, 118000), pg_temp.a(v_m2, 118000)), null, null);
  v_i1 := pg_temp.inv_of(v_m1); v_i2 := pg_temp.inv_of(v_m2);

  p := public.project_receipt_undo_preview(v_t);
  perform pg_temp.check(not (p->>'blocked')::boolean and jsonb_array_length(p->'rows') = 2
                        and (p->>'bank_total')::int = 236000 and (p->>'tds_total')::int = 0,
    format('c2 preview: 2 kists, ₹2,36,000, not blocked (%s)', p));
  perform pg_temp.check((select bool_and(x->>'before_status' = 'paid' and x->>'after_status' = 'invoiced'
                                         and (x->>'after_paid')::int = 0 and x->>'invoice_status_before' = 'paid'
                                         and x->>'invoice_status_after' = 'pending' and x->>'invoice_id' is not null
                                         and x->>'href' = '/projects/' || v_p::text)
                           from jsonb_array_elements(p->'rows') x),
    'c2 preview: each kist Paid → Invoiced, ₹0 paid, its invoice Paid → due, link to the project');
  perform pg_temp.check(pg_temp.ms_paid(v_m1) = 118000 and pg_temp.ms_paid(v_m2) = 118000
                        and (select matched_to_type from public.bank_transactions where id = v_t) = 'project'
                        and (select status::text from public.invoices where id = v_i1) = 'paid',
    'c2 preview changed nothing (payments, line, invoice as before)');

  r := public.unreconcile_bank_receipt(v_t, false);
  perform pg_temp.check(pg_temp.ms_paid(v_m1) = 0 and pg_temp.ms_paid(v_m2) = 0,
    format('c2: BOTH kists'' payments removed (still ₹%s / ₹%s)', pg_temp.ms_paid(v_m1), pg_temp.ms_paid(v_m2)));
  perform pg_temp.check(not exists (select 1 from public.project_payments where project_id = v_p), 'c2: no project payment left on the project');
  perform pg_temp.check((select bool_and(status = 'invoiced') from public.project_milestones where id in (v_m1, v_m2)), 'c2: both kists back to Invoiced');
  perform pg_temp.check((select count(*) = 2 and bool_and(status::text = 'pending' and coalesce(paid_amount, 0) = 0)
                           from public.invoices where id in (v_i1, v_i2)),
    'c2 D3: both invoices stay, due again');
  perform pg_temp.check((r->>'project_payments_removed')::int = 2 and (r->>'project_amount_removed')::int = 236000
                        and jsonb_array_length(r->'invoices_due_again') = 2,
    format('c2: result says 2 payments, ₹2,36,000, 2 invoices due (%s)', r));
  perform pg_temp.check((select matched_to_type is null and matched_to_id is null from public.bank_transactions where id = v_t), 'c2: line free');
  perform pg_temp.check(pg_temp.undep_since('c2') = 0, format('c2 GL: Undeposited 0 (got %s)', pg_temp.undep_since('c2')));
end $$;

-- ── 3. with TDS (R-1996): TDS payments + TDS receivable rows go too; re-book, no double count ─
do $$
declare v_p uuid; v_m1 uuid; v_m2 uuid; v_q uuid; v_n1 uuid; v_n2 uuid; v_t uuid; p jsonb; r jsonb; v_inv text[];
begin
  perform pg_temp.snap('c3');
  v_p  := pg_temp.project('C3 WRONG ERP', array[118000, 118000]);
  v_q  := pg_temp.project('C3 RIGHT ERP', array[118000, 118000], 'f1999000-0000-4000-8000-0000000000c2');
  v_m1 := pg_temp.ms(v_p, 1); v_m2 := pg_temp.ms(v_p, 2);
  v_n1 := pg_temp.ms(v_q, 1); v_n2 := pg_temp.ms(v_q, 2);
  v_t  := pg_temp.txn(212400, date '2026-10-16', 'RTGS-R1999 KIST 1+2 LESS TDS');
  perform public.allocate_project_receipt_with_tds(v_t, v_p,
            pg_temp.alloc(pg_temp.a(v_m1, 118000), pg_temp.a(v_m2, 118000)), pg_temp.tds(23600), null, null);
  perform pg_temp.check(pg_temp.tds_since('c3') = 23600, 'c3 setup: TDS receivable +₹23,600');

  p := public.project_receipt_undo_preview(v_t);
  perform pg_temp.check(not (p->>'blocked')::boolean and (p->>'bank_total')::int = 212400 and (p->>'tds_total')::int = 23600
                        and (select bool_and((x->>'tds')::int = 11800 and (x->>'bank')::int = 106200) from jsonb_array_elements(p->'rows') x),
    format('c3 preview: ₹2,12,400 bank + ₹23,600 TDS, ₹11,800 per kist (%s)', p));

  r := public.unreconcile_bank_receipt(v_t, false);
  perform pg_temp.check(not exists (select 1 from public.project_payments where project_id = v_p),
    'c3: bank AND TDS payments (method tds) removed');
  perform pg_temp.check(not exists (select 1 from public.tds_receivable
                                     where tenant_id = 'f1999000-0000-4000-8000-000000000001'
                                       and invoice_id in (pg_temp.inv_of(v_m1), pg_temp.inv_of(v_m2))),
    'c3: both TDS receivable rows removed');
  perform pg_temp.check(pg_temp.tds_since('c3') = 0, format('c3 GL: TDS receivable back where it was (got %s)', pg_temp.tds_since('c3')));
  perform pg_temp.check((r->>'project_payments_removed')::int = 4 and (r->>'project_tds_removed')::int = 23600,
    format('c3: result says 4 payments, ₹23,600 TDS removed (%s)', r));
  perform pg_temp.check((select count(*) = 2 and bool_and(status::text = 'pending') from public.invoices
                          where id in (pg_temp.inv_of(v_m1), pg_temp.inv_of(v_m2))),
    'c3 D3: both invoices stay, due again');

  -- re-book the same line + TDS to the right project
  perform public.allocate_project_receipt_with_tds(v_t, v_q,
            pg_temp.alloc(pg_temp.a(v_n1, 118000), pg_temp.a(v_n2, 118000)), pg_temp.tds(23600), null, null);
  perform pg_temp.check(pg_temp.cash_since('c3') = 212400 and pg_temp.undep_since('c3') = 0,
    format('c3 GL: bank ₹2,12,400 once, Undeposited 0 — no double count (got %s / %s)', pg_temp.cash_since('c3'), pg_temp.undep_since('c3')));
  perform pg_temp.check(pg_temp.tds_since('c3') = 23600, format('c3 GL: TDS receivable ₹23,600 once (got %s)', pg_temp.tds_since('c3')));
  perform pg_temp.check(pg_temp.net_since('c3') = 4 * 118000,
    format('c3 GL balanced: assets added = invoiced (2 wrong invoices due + 2 right ones paid = ₹4,72,000) (got %s)', pg_temp.net_since('c3')));
end $$;

-- ── 4. refused with a link, nothing changed ───────────────────────────────────────────────────
do $$
declare v_p uuid; v_m1 uuid; v_t uuid; p jsonb; v_msg text; v_hint text; v_state text;
begin
  v_p  := pg_temp.project('C4 cert in', array[118000]);
  v_m1 := pg_temp.ms(v_p, 1);
  v_t  := pg_temp.txn(106200, date '2026-10-17', 'NEFT-R1999 LESS TDS CERT');
  perform public.allocate_project_receipt_with_tds(v_t, v_p, pg_temp.alloc(pg_temp.a(v_m1, 118000)), pg_temp.tds(11800), null, null);
  update public.tds_receivable set status = 'cert_received' where invoice_id = pg_temp.inv_of(v_m1);

  p := public.project_receipt_undo_preview(v_t);
  perform pg_temp.check((p->>'blocked')::boolean and p->>'block_href' = '/accounting/tds-receivable'
                        and p->>'block_message' ilike '%cert received%' and jsonb_array_length(p->'rows') = 1,
    format('c4 preview: blocked — TDS certificate already in, link to TDS receivable (%s)', p));
  begin
    perform public.unreconcile_bank_receipt(v_t, false);
    raise exception 'R-1999 FAIL: c4 — un-reconcile with a TDS certificate in was ACCEPTED';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
    if v_msg like 'R-1999 FAIL%' then raise; end if;
    perform pg_temp.check(v_hint = '/accounting/tds-receivable', format('c4: refused with the TDS page (%s / %s)', v_msg, v_hint));
  end;
  perform pg_temp.check(pg_temp.ms_paid(v_m1) = 118000 and (select matched_to_type from public.bank_transactions where id = v_t) = 'project',
    'c4: nothing changed (payments + line as before)');

  -- a billing user may free a line, but not remove the payments it booked
  update public.tds_receivable set status = 'pending_cert' where invoice_id = pg_temp.inv_of(v_m1);
  perform pg_temp.as_user('f1999000-0000-4000-8000-0000000000a2');
  p := public.project_receipt_undo_preview(v_t);
  perform pg_temp.check((p->>'blocked')::boolean and p->>'block_message' ilike '%owner or accountant%',
    format('c4 preview (billing user): blocked — ask an owner or accountant (%s)', p->>'block_message'));
  begin
    perform public.unreconcile_bank_receipt(v_t, false);
    raise exception 'R-1999 FAIL: c4 — a billing user removed project payments';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    if v_msg like 'R-1999 FAIL%' then raise; end if;
    perform pg_temp.check(v_state = '42501', format('c4: billing user refused (%s %s)', v_state, v_msg));
  end;
  perform pg_temp.as_user('f1999000-0000-4000-8000-0000000000a1');
  perform pg_temp.check(pg_temp.ms_paid(v_m1) = 118000, 'c4: still nothing changed');
end $$;

-- ── 5. "Undo sale" on a project line does the same one-place undo (c8 part 2) ─────────────────
do $$
declare v_t uuid; v_m uuid;
begin
  v_t := pg_temp.txn(5000, date '2026-10-18', 'UPI-R1999-UNDO-SALE');
  v_m := pg_temp.ms(pg_temp.project('C5 undo-sale', array[5000]), 1);
  perform public.record_project_payment(v_m, 5000, 'bank_transfer', 'x', date '2026-10-18', v_t);
  perform public.unreconcile_bank_receipt(v_t, true);
  perform pg_temp.check(pg_temp.ms_paid(v_m) = 0 and (select status from public.project_milestones where id = v_m) = 'pending'
                        and (select matched_to_type from public.bank_transactions where id = v_t) is null,
    'c5: undo sale on a project line removes the payment, kist back to Pending, line free');
end $$;

-- ── 6. the preview refuses a line that is not a project payment ──────────────────────────────
do $$
declare v_t uuid;
begin
  v_t := pg_temp.txn(1000, date '2026-10-19', 'UPI-R1999-NOT-PROJECT');
  begin
    perform public.project_receipt_undo_preview(v_t);
    raise exception 'R-1999 FAIL: c6 — preview of a non-project line was ACCEPTED';
  exception when others then
    if sqlerrm like 'R-1999 FAIL%' then raise; end if;
    perform pg_temp.check(sqlerrm ilike '%not a project payment%', 'c6: preview refuses a non-project line (' || sqlerrm || ')');
  end;
end $$;

select 'R-1999 project receipt undo: PASS' as result;
rollback;
