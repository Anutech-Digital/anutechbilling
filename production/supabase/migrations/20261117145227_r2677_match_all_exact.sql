-- deploy-peek: to_regclass('public.bank_exact_match_run_lines') is not null and to_regprocedure('public.bank_exact_match_candidates(uuid,date,date,text)') is not null and to_regprocedure('public.book_bank_exact_matches(uuid,jsonb)') is not null and to_regprocedure('public.undo_bank_exact_match_run(uuid)') is not null
-- deploy-key: r2677matchallexact
--
-- R-2677 (17 Nov 2026, p0 paisa, G-RECON — Pardeep: "sabse pehle yahi kaam complete karna hai"; "jo
-- logically thik ho wo kro"). Hand reconcile of HDFC 4523 runs at ~16 lines an hour: each line is
-- ~3 clicks and 20–30 s page loads, yet many open lines already have an EXACT record in the books (an
-- imported Zoho expense, a customer receipt with the line's UTR, a payment "already paid on … from the
-- Bills / Expenses page"). This file clears those in one press, under a run id that can be undone.
--
-- ─── WHAT THIS ADDS ───────────────────────────────────────────────────────────
--   bank_exact_match_runs / bank_exact_match_run_lines — one row per run (company, account, the filter
--     it ran on, who, when, undone) and one per line it matched: the record, why it was exact, and the
--     line's matched_to_type / matched_to_id / matched_at right after the match (Undo touches only
--     that). A line sits in at most one live (not undone) run line (partial unique index). RLS: a
--     company reads only its own; nobody writes them directly (only the functions below).
--   bank_exact_match_candidates(account, from, to, dir) — read only. Every OPEN line of that account
--     inside the filter (dates inclusive; dir 'in' / 'out' / 'all'), at most 2,000 (oldest first), each
--     with a status and a plain reason:
--       'exact'     — the app's OWN matcher finds exactly one record and nothing else could be the line:
--                     (a) suggest_bank_transaction_matches (the drawer's "Suggested matches") gives ONE
--                         'exact' candidate (receipt / project receipt: same amount + same day, or the
--                         line's own UTR; expense: same amount + same day), no other candidate is
--                         'exact' / 'high' or has the same amount; the expense is PAID with no TDS on it;
--                         the receipt is not a customer advance (un-reconciling an advance deletes it);
--                     (b) or, for money out with no such candidate, bank_debit_vendor_auto_match
--                         (R-1867 / R-1911) gives ONE row and it is a RECORDED payment (Bills page Pay /
--                         payment run / Expenses → Mark paid — R-1911 "match, don't add again");
--                     and no EMI of that amount is due (emi_matches_for_bank_txn), and no OTHER open line
--                     of the company (any account, same side, same amount) lies within 7 days of the
--                     record or of the line (30 days of the line for a recorded payment) — one record
--                     covers at most one line (money rules S7 / S9), so two lines → both 'ambiguous'.
--       'ambiguous' — more than one record could be the line, or more than one line the record.
--       'locked'    — the line or the record is on / before the books lock (books_locked_until).
--       'drawer'    — the matcher's answer is not a plain link to an existing record, so it stays a
--                     one-line job in the drawer: a Payroll salary (Payroll's checks and the F&F prompt
--                     run there), an EMI (books a loan repayment), paying an OPEN bill (a new payment),
--                     an unpaid expense bill, an expense with TDS, a customer advance receipt.
--       'likely'    — only a 'high' / 'low' candidate (₹1 apart, a few days off): never booked here.
--       'none'      — no record in the books for this line.
--   book_bank_exact_matches(account, rows jsonb [{txn_id, match_type, match_id}]) — the browser's list is
--     never trusted: for every row the SERVER locks the line, works the answer out again with the same
--     function, and books ONLY when it is still 'exact' with the SAME record the browser showed (a
--     changed or made-up row is skipped with its reason). Then it locks the record and checks it is
--     still free, and links it through the one existing path (each row in its own savepoint):
--       receipt / project receipt / expense → reconcile_bank_txn(line, type, id, 'exact') — the drawer's
--         "Match" — and the line must end up pointing at exactly that record;
--       recorded payment → reconcile_bank_debit_to_vendor(line, vendor, items [{source:'recorded_payment',
--         doc_id, amount}]) — the drawer's vendor section; the real line takes the recorded payment's
--         place (R-1911), paid_amount does not move.
--     Never creates an expense, bill, sale, receipt, GST or TDS row (a GST-filed month — money rule G12
--     — never changes: only existing records are linked). Returns {run_id (null when nothing was
--     matched), booked, skipped:[{txn_id, reason}]}. Pressing Match twice matches nothing the second time.
--   undo_bank_exact_match_run(run) — every line of the run still matched exactly as the run left it
--     (type, id and matched_at) goes back through unreconcile_bank_receipt(line, false) — the line's own
--     Un-reconcile, which puts a recorded payment's manual line / Mark-paid back (R-1911 trigger). A line
--     changed by hand since is released from the run and listed; a refused one (books lock) stays in the
--     run and is listed. The run is marked undone when no line of it is left. Run again → 0.
--   All four: owner / accountant only (as Find pairs R-2656 and Reconcile from Zoho R-2535), own company.
-- Functions this file only CALLS (unchanged): suggest_bank_transaction_matches (R-2192),
-- bank_debit_vendor_auto_match / bank_debit_vendor_open_items (R-1911 / R-2502c), emi_matches_for_bank_txn
-- (R-2529), reconcile_bank_txn (R-2472), reconcile_bank_debit_to_vendor (R-1916),
-- unreconcile_bank_receipt (R-2179), bank_advance_payment.
-- Test: supabase/tests/r2677_match_all_exact.test.sql (begin … rollback; red without this file).

begin;

create table if not exists public.bank_exact_match_runs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  filter          jsonb not null default '{}'::jsonb,
  booked          integer not null default 0,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  undone_at       timestamptz,
  undone_by       uuid
);
create index if not exists bank_exact_match_runs_tenant_idx on public.bank_exact_match_runs (tenant_id, created_at desc);

create table if not exists public.bank_exact_match_run_lines (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references public.bank_exact_match_runs(id) on delete cascade,
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  bank_txn_id      uuid not null references public.bank_transactions(id) on delete cascade,
  kind             text not null check (kind in ('payment', 'project', 'expense', 'recorded_payment')),
  match_id         text not null,
  match_label      text,
  amount           integer not null check (amount > 0),
  why              text,
  matched_to_type  text,
  matched_to_id    text,
  matched_at       timestamptz,
  booked_at        timestamptz not null default now(),
  undone_at        timestamptz,
  undo_note        text
);
create index if not exists bank_exact_match_run_lines_run_idx on public.bank_exact_match_run_lines (run_id);
create unique index if not exists bank_exact_match_run_lines_live
  on public.bank_exact_match_run_lines (bank_txn_id) where undone_at is null;

alter table public.bank_exact_match_runs enable row level security;
alter table public.bank_exact_match_run_lines enable row level security;
drop policy if exists bank_exact_match_runs_read on public.bank_exact_match_runs;
create policy bank_exact_match_runs_read on public.bank_exact_match_runs for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists bank_exact_match_run_lines_read on public.bank_exact_match_run_lines;
create policy bank_exact_match_run_lines_read on public.bank_exact_match_run_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.bank_exact_match_runs;
create policy zzz_service_role_all on public.bank_exact_match_runs as permissive for all to service_role using (true) with check (true);
drop policy if exists zzz_service_role_all on public.bank_exact_match_run_lines;
create policy zzz_service_role_all on public.bank_exact_match_run_lines as permissive for all to service_role using (true) with check (true);
revoke all on public.bank_exact_match_runs, public.bank_exact_match_run_lines from public, anon;
grant select on public.bank_exact_match_runs, public.bank_exact_match_run_lines to authenticated, service_role;

/* The gate: a signed-in owner / accountant of a company. Returns the company. */
create or replace function public._r2677_exact_gate()
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'No company on this login — sign in again.' using errcode = '42501';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant can match many bank lines at once' using errcode = '42501';
  end if;
  return v_tenant;
end;
$function$;
revoke all on function public._r2677_exact_gate() from public, anon;
grant execute on function public._r2677_exact_gate() to authenticated, service_role;

/* One line's answer. Internal: called only by the three functions below (never granted to a login). */
create or replace function public._r2677_exact_for_line(p_txn_id uuid)
returns table (status text, kind text, match_id text, vendor_id uuid, match_label text,
               match_amount integer, match_date date, why text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_txn     public.bank_transactions;
  v_lock    date;
  v_amt     integer;
  v_credit  boolean;
  v_n_exact integer := 0;
  v_n_sure  integer := 0;
  v_n_same  integer := 0;
  v_top     record;
  v_n_vp    integer := 0;
  v_vp      record;
  v_n_emi   integer := 0;
  v_exp     public.expenses;
  v_paid_on date;
  v_rival   record;
  v_vname   text;
begin
  select * into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found then return; end if;
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_txn.tenant_id;
  v_amt := greatest(coalesce(v_txn.debit, 0), coalesce(v_txn.credit, 0));
  v_credit := coalesce(v_txn.credit, 0) > 0;

  if v_txn.matched_to_type is not null or v_txn.matched_to_id is not null then
    return query select 'none'::text, null::text, null::text, null::uuid, null::text, null::integer, null::date,
      'Already reconciled.'::text;
    return;
  end if;
  if v_lock is not null and v_txn.txn_date <= v_lock then
    return query select 'locked'::text, null::text, null::text, null::uuid, null::text, null::integer, null::date,
      format('Books are locked up to %s.', to_char(v_lock, 'DD Mon YYYY'));
    return;
  end if;

  /* (a) The drawer's own suggestions, in the drawer's order. */
  for v_rival in
    select s.match_type, s.match_id, s.match_label, s.match_amount, s.match_date, s.match_confidence
      from public.suggest_bank_transaction_matches(p_txn_id)
           with ordinality as s(match_type, match_id, match_label, match_amount, match_date, match_confidence, ord)
     order by s.ord
  loop
    if v_rival.match_confidence = 'exact' then
      v_n_exact := v_n_exact + 1;
      if v_n_exact = 1 then v_top := v_rival; end if;
    end if;
    if v_rival.match_confidence in ('exact', 'high') then v_n_sure := v_n_sure + 1; end if;
    if v_rival.match_amount = v_amt then v_n_same := v_n_same + 1; end if;
  end loop;

  /* Money out: what the R-1867 / R-1911 vendor matcher and the EMI matcher would do with the line. */
  if not v_credit then
    for v_rival in select m.* from public.bank_debit_vendor_auto_match(p_txn_id) m loop
      v_n_vp := v_n_vp + 1;
      if v_n_vp = 1 then v_vp := v_rival; end if;
    end loop;
    select count(*) into v_n_emi
      from public.emi_matches_for_bank_txn(p_txn_id) m
     where m.difference = 0 and m.confidence in ('exact', 'high');
  end if;

  if v_n_exact > 1 then
    return query select 'ambiguous'::text, null::text, null::text, null::uuid, null::text, null::integer, null::date,
      format('%s records in the books match this line exactly — pick the right one in the line''s drawer.', v_n_exact);
    return;
  end if;

  if v_n_exact = 1 then
    if v_n_sure > 1 or v_n_same > 1 then
      return query select 'ambiguous'::text, v_top.match_type, v_top.match_id, null::uuid, v_top.match_label, v_top.match_amount, v_top.match_date,
        format('%s records could be this line (same amount or a close match) — pick the right one in the line''s drawer.', greatest(v_n_sure, v_n_same));
      return;
    end if;
    if v_n_emi > 0 then
      return query select 'ambiguous'::text, v_top.match_type, v_top.match_id, null::uuid, v_top.match_label, v_top.match_amount, v_top.match_date,
        'An EMI of this amount is also due — pick the right one in the line''s drawer.'::text;
      return;
    end if;
    if v_n_vp > 0 then   -- (nested: v_vp is unassigned when the vendor matcher gave nothing)
      if not (v_n_vp = 1 and v_vp.doc_id = v_top.match_id) then
        return query select 'ambiguous'::text, v_top.match_type, v_top.match_id, null::uuid, v_top.match_label, v_top.match_amount, v_top.match_date,
          'The vendor also has an open bill or a recorded payment of this amount — pick the right one in the line''s drawer.'::text;
        return;
      end if;
    end if;
    if v_top.match_type not in ('payment', 'project', 'expense') then
      return query select 'drawer'::text, v_top.match_type, v_top.match_id, null::uuid, v_top.match_label, v_top.match_amount, v_top.match_date,
        case when v_top.match_type = 'salary'
             then 'A Payroll salary — match it in the line''s drawer, where Payroll''s checks run.'
             else 'Match this one in the line''s drawer.' end;
      return;
    end if;
    if v_top.match_type = 'payment' and public.bank_advance_payment(public.bank_match_uuid(v_top.match_id)) then
      return query select 'drawer'::text, v_top.match_type, v_top.match_id, null::uuid, v_top.match_label, v_top.match_amount, v_top.match_date,
        'A customer advance receipt — match it in the line''s drawer.'::text;
      return;
    end if;
    if v_top.match_type = 'expense' then
      select * into v_exp from public.expenses e where e.id = v_top.match_id and e.tenant_id = v_txn.tenant_id;
      if not found or not coalesce(v_exp.paid, false) then
        return query select 'drawer'::text, v_top.match_type, v_top.match_id, null::uuid, v_top.match_label, v_top.match_amount, v_top.match_date,
          'An UNPAID expense bill — pay it from the line''s drawer.'::text;
        return;
      end if;
      if coalesce(v_exp.tds_amount, 0) <> 0 then
        return query select 'drawer'::text, v_top.match_type, v_top.match_id, null::uuid, v_top.match_label, v_top.match_amount, v_top.match_date,
          'The expense has TDS on it — check it in the line''s drawer.'::text;
        return;
      end if;
    end if;
    if v_lock is not null and v_top.match_date <= v_lock then
      return query select 'locked'::text, v_top.match_type, v_top.match_id, null::uuid, v_top.match_label, v_top.match_amount, v_top.match_date,
        format('The record is dated inside the locked books (up to %s).', to_char(v_lock, 'DD Mon YYYY'));
      return;
    end if;
    /* One record, one line: another OPEN line of the company could be this record too → both wait. */
    select t.txn_date, ba.name as account into v_rival
      from public.bank_transactions t
      left join public.bank_accounts ba on ba.id = t.bank_account_id
     where t.tenant_id = v_txn.tenant_id and t.id <> v_txn.id
       and t.matched_to_type is null and t.matched_to_id is null
       and (coalesce(t.credit, 0) > 0) = v_credit
       and greatest(coalesce(t.debit, 0), coalesce(t.credit, 0)) = v_amt
       and (abs(t.txn_date - v_top.match_date) <= 7 or abs(t.txn_date - v_txn.txn_date) <= 7)
     order by abs(t.txn_date - v_txn.txn_date), t.id
     limit 1;
    if found then
      return query select 'ambiguous'::text, v_top.match_type, v_top.match_id, null::uuid, v_top.match_label, v_top.match_amount, v_top.match_date,
        format('Another open line (%s, %s) has the same amount and could be this record — match these by hand.',
               to_char(v_rival.txn_date, 'DD Mon YYYY'), coalesce(v_rival.account, 'another account'));
      return;
    end if;
    return query select 'exact'::text, v_top.match_type, v_top.match_id, null::uuid, v_top.match_label, v_top.match_amount, v_top.match_date,
      case when v_top.match_date = v_txn.txn_date
           then format('Same amount, same date — the only %s it can be.',
                       case v_top.match_type when 'payment' then 'receipt' when 'project' then 'project receipt' else 'expense' end)
           else format('Same amount and the line''s own UTR / reference (%s days apart) — the only receipt it can be.',
                       abs(v_top.match_date - v_txn.txn_date)) end;
    return;
  end if;

  /* (b) No exact suggestion. Money out: a payment already RECORDED outside the bank (R-1911). */
  if not v_credit and v_n_vp > 0 then
    if v_n_vp > 1 then
      return query select 'ambiguous'::text, null::text, null::text, null::uuid, null::text, null::integer, null::date,
        format('The vendor has %s open bills or recorded payments of this amount — pick the right one in the line''s drawer.', v_n_vp);
      return;
    end if;
    if v_vp.source <> 'recorded_payment' then
      return query select 'drawer'::text, null::text, v_vp.doc_id, v_vp.vendor_id, v_vp.bill_no, v_vp.amount, null::date,
        'This would PAY an open bill (a new payment, not an existing record) — pay it from the line''s drawer.'::text;
      return;
    end if;
    select v.name into v_vname from public.vendors v where v.id = v_vp.vendor_id;
    select o.paid_on into v_paid_on
      from public.bank_debit_vendor_open_items(v_vp.vendor_id) o
     where o.source = 'recorded_payment' and o.doc_id = v_vp.doc_id
     limit 1;
    if v_n_sure > 0 or v_n_same > 0 or v_n_emi > 0 then
      return query select 'ambiguous'::text, 'recorded_payment'::text, v_vp.doc_id, v_vp.vendor_id,
        concat_ws(' · ', v_vname, v_vp.bill_no), v_vp.amount, v_paid_on,
        'Another record in the books has this amount too — pick the right one in the line''s drawer.'::text;
      return;
    end if;
    if v_paid_on is null then
      return query select 'none'::text, null::text, null::text, null::uuid, null::text, null::integer, null::date,
        'The recorded payment could not be read again — open the line''s drawer.'::text;
      return;
    end if;
    if v_lock is not null and v_paid_on <= v_lock then
      return query select 'locked'::text, 'recorded_payment'::text, v_vp.doc_id, v_vp.vendor_id,
        concat_ws(' · ', v_vname, v_vp.bill_no), v_vp.amount, v_paid_on,
        format('The recorded payment is dated inside the locked books (up to %s).', to_char(v_lock, 'DD Mon YYYY'));
      return;
    end if;
    select t.txn_date, ba.name as account into v_rival
      from public.bank_transactions t
      left join public.bank_accounts ba on ba.id = t.bank_account_id
     where t.tenant_id = v_txn.tenant_id and t.id <> v_txn.id
       and t.matched_to_type is null and t.matched_to_id is null
       and coalesce(t.debit, 0) = v_amt
       and (abs(t.txn_date - v_txn.txn_date) <= 30 or abs(t.txn_date - v_paid_on) <= 30)
     order by abs(t.txn_date - v_txn.txn_date), t.id
     limit 1;
    if found then
      return query select 'ambiguous'::text, 'recorded_payment'::text, v_vp.doc_id, v_vp.vendor_id,
        concat_ws(' · ', v_vname, v_vp.bill_no), v_vp.amount, v_paid_on,
        format('Another open line (%s, %s) has the same amount and could be this payment — match these by hand.',
               to_char(v_rival.txn_date, 'DD Mon YYYY'), coalesce(v_rival.account, 'another account'));
      return;
    end if;
    return query select 'exact'::text, 'recorded_payment'::text, v_vp.doc_id, v_vp.vendor_id,
      concat_ws(' · ', v_vname, v_vp.bill_no), v_vp.amount, v_paid_on,
      format('Already recorded as paid on %s (Bills / Expenses page) — the vendor named on the line, same amount.',
             to_char(v_paid_on, 'DD Mon YYYY'));
    return;
  end if;

  if v_n_emi > 0 then
    return query select 'drawer'::text, null::text, null::text, null::uuid, null::text, null::integer, null::date,
      'An EMI — book it in the line''s drawer (it books a loan repayment).'::text;
    return;
  end if;
  if v_n_sure > 0 or v_n_same > 0 then
    return query select 'likely'::text, null::text, null::text, null::uuid, null::text, null::integer, null::date,
      'Only a close match, not an exact one — check it in the line''s drawer.'::text;
    return;
  end if;
  return query select 'none'::text, null::text, null::text, null::uuid, null::text, null::integer, null::date,
    'No record in the books for this line.'::text;
end;
$function$;
revoke all on function public._r2677_exact_for_line(uuid) from public, anon, authenticated;
grant execute on function public._r2677_exact_for_line(uuid) to service_role;

create or replace function public.bank_exact_match_candidates(
  p_account_id uuid,
  p_from       date default null,
  p_to         date default null,
  p_dir        text default 'all'
) returns table (txn_id uuid, txn_date date, description text, amount integer, direction text,
                 status text, kind text, match_id text, match_label text, match_amount integer,
                 match_date date, why text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public._r2677_exact_gate();
  v_dir    text := lower(coalesce(p_dir, 'all'));
  v_t      record;
  v_r      record;
begin
  if v_dir not in ('all', 'in', 'out') then
    raise exception 'Money in / out must be in, out or all.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.bank_accounts ba where ba.id = p_account_id and ba.tenant_id = v_tenant) then
    raise exception 'Bank account not found' using errcode = 'no_data_found';
  end if;
  for v_t in
    select bt.id, bt.txn_date, bt.description, bt.debit, bt.credit
      from public.bank_transactions bt
     where bt.tenant_id = v_tenant and bt.bank_account_id = p_account_id
       and bt.matched_to_type is null and bt.matched_to_id is null
       and greatest(coalesce(bt.debit, 0), coalesce(bt.credit, 0)) > 0
       and (p_from is null or bt.txn_date >= p_from)
       and (p_to is null or bt.txn_date <= p_to)
       and (v_dir = 'all' or (v_dir = 'in' and coalesce(bt.credit, 0) > 0) or (v_dir = 'out' and coalesce(bt.debit, 0) > 0))
     order by bt.txn_date, bt.id
     limit 2000
  loop
    select * into v_r from public._r2677_exact_for_line(v_t.id) x limit 1;
    txn_id := v_t.id; txn_date := v_t.txn_date; description := v_t.description;
    amount := greatest(coalesce(v_t.debit, 0), coalesce(v_t.credit, 0))::integer;
    direction := case when coalesce(v_t.credit, 0) > 0 then 'in' else 'out' end;
    status := coalesce(v_r.status, 'none'); kind := v_r.kind; match_id := v_r.match_id;
    match_label := v_r.match_label; match_amount := v_r.match_amount; match_date := v_r.match_date;
    why := coalesce(v_r.why, 'No record in the books for this line.');
    return next;
  end loop;
end;
$function$;
revoke all on function public.bank_exact_match_candidates(uuid, date, date, text) from public, anon;
grant execute on function public.bank_exact_match_candidates(uuid, date, date, text) to authenticated, service_role;

create or replace function public.book_bank_exact_matches(p_account_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant  uuid := public._r2677_exact_gate();
  v_run     uuid;
  v_row     record;
  v_txn     public.bank_transactions;
  v_r       record;
  v_n       integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_seen    uuid[] := '{}';
  v_seen_rec text[] := '{}';
  v_after   public.bank_transactions;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Send the lines to match as a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Match at most 2,000 lines at a time.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.bank_accounts ba where ba.id = p_account_id and ba.tenant_id = v_tenant) then
    raise exception 'Bank account not found' using errcode = 'no_data_found';
  end if;

  /* The run row first, outside every line's savepoint (a failed line must not take it with it). */
  insert into public.bank_exact_match_runs (tenant_id, bank_account_id, filter, created_by)
  values (v_tenant, p_account_id, jsonb_build_object('rows_sent', jsonb_array_length(p_rows)), public.current_user_id())
  returning id into v_run;

  for v_row in
    select public.bank_match_uuid(e->>'txn_id') as tid, e->>'txn_id' as raw_tid,
           e->>'match_type' as mtype, e->>'match_id' as mid
      from jsonb_array_elements(p_rows) e
  loop
    if v_row.tid is null then
      v_skipped := v_skipped || jsonb_build_object('txn_id', v_row.raw_tid, 'reason', 'Not a bank line id.');
      continue;
    end if;
    if v_row.tid = any (v_seen) then
      v_skipped := v_skipped || jsonb_build_object('txn_id', v_row.tid, 'reason', 'Listed twice — matched once.');
      continue;
    end if;
    v_seen := v_seen || v_row.tid;

    begin
      /* Lock the line; it must be this company's, in this account, and still open. */
      select * into v_txn from public.bank_transactions t
       where t.id = v_row.tid and t.tenant_id = v_tenant and t.bank_account_id = p_account_id
       for update;
      if not found then
        raise exception 'Not a line of this bank account.' using errcode = 'check_violation';
      end if;
      if v_txn.matched_to_type is not null or v_txn.matched_to_id is not null then
        raise exception 'Already reconciled (matched meanwhile).' using errcode = 'check_violation';
      end if;

      /* The server decides, now: the same answer the preview showed, or nothing. */
      select * into v_r from public._r2677_exact_for_line(v_row.tid) x limit 1;
      if v_r.status is distinct from 'exact' then
        raise exception '%', coalesce(v_r.why, 'Not an exact match any more.') using errcode = 'check_violation';
      end if;
      if v_r.kind is distinct from v_row.mtype or v_r.match_id is distinct from v_row.mid then
        raise exception 'The record for this line is not the one the preview showed — open the list again.' using errcode = 'check_violation';
      end if;
      if (v_r.kind || ':' || v_r.match_id) = any (v_seen_rec) then
        raise exception 'This record was already matched to another line in this run.' using errcode = 'check_violation';
      end if;

      /* Lock the record and check it is still free (two lines at the same moment wait for each other). */
      if v_r.kind = 'expense' then
        perform 1 from public.expenses e where e.id = v_r.match_id and e.tenant_id = v_tenant for update;
        if exists (select 1 from public.expenses e where e.id = v_r.match_id and e.tenant_id = v_tenant and e.reconciled_txn_id is not null)
           or exists (select 1 from public.bank_transactions t where t.tenant_id = v_tenant and t.id <> v_row.tid
                       and t.matched_to_type = 'expense' and t.matched_to_id = v_r.match_id) then
          raise exception 'The expense was matched to another line meanwhile.' using errcode = 'check_violation';
        end if;
      elsif v_r.kind = 'project' then
        perform 1 from public.project_payments pp where pp.id = public.bank_match_uuid(v_r.match_id) and pp.tenant_id = v_tenant for update;
        if exists (select 1 from public.project_payments pp where pp.id = public.bank_match_uuid(v_r.match_id) and pp.bank_txn_id is not null) then
          raise exception 'The project receipt was matched to another line meanwhile.' using errcode = 'check_violation';
        end if;
      end if;

      if v_r.kind in ('payment', 'project', 'expense') then
        /* receipt: reconcile_bank_txn locks the receipt and refuses one another line already holds (R-2364). */
        perform public.reconcile_bank_txn(v_row.tid, v_r.kind, v_r.match_id, 'exact');
        select * into v_after from public.bank_transactions t where t.id = v_row.tid;
        if v_after.matched_to_type is distinct from v_r.kind or v_after.matched_to_id is distinct from v_r.match_id then
          raise exception 'The line did not end up on that record — not matched.' using errcode = 'check_violation';
        end if;
      else
        perform public.reconcile_bank_debit_to_vendor(
          v_row.tid, v_r.vendor_id, null,
          jsonb_build_array(jsonb_build_object('source', 'recorded_payment', 'doc_id', v_r.match_id, 'amount', v_r.match_amount)),
          null, 0, null, 0, 'Match all exact (R-2677)');
        select * into v_after from public.bank_transactions t where t.id = v_row.tid;
        if v_after.matched_to_type is null then
          raise exception 'The line did not end up reconciled — not matched.' using errcode = 'check_violation';
        end if;
      end if;

      /* The line was open, so a live run line still naming it is stale (un-reconciled by hand after
         that run) — release it, or the one-live-line index would block this match for ever. */
      update public.bank_exact_match_run_lines l
         set undone_at = now(), undo_note = 'Released: the line was un-reconciled by hand after this run.'
       where l.tenant_id = v_tenant and l.undone_at is null and l.bank_txn_id = v_row.tid;

      insert into public.bank_exact_match_run_lines
        (run_id, tenant_id, bank_txn_id, kind, match_id, match_label, amount, why, matched_to_type, matched_to_id, matched_at)
      values
        (v_run, v_tenant, v_row.tid, v_r.kind, v_r.match_id, v_r.match_label,
         greatest(coalesce(v_txn.debit, 0), coalesce(v_txn.credit, 0)), v_r.why,
         v_after.matched_to_type, v_after.matched_to_id, v_after.matched_at);
      v_seen_rec := v_seen_rec || (v_r.kind || ':' || v_r.match_id);
      v_n := v_n + 1;
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('txn_id', v_row.tid, 'reason', sqlerrm);
    end;
  end loop;

  if v_n = 0 then
    delete from public.bank_exact_match_runs where id = v_run;
    v_run := null;
  else
    update public.bank_exact_match_runs set booked = v_n where id = v_run;
  end if;
  return jsonb_build_object('run_id', v_run, 'booked', v_n, 'skipped', v_skipped);
end;
$function$;
revoke all on function public.book_bank_exact_matches(uuid, jsonb) from public, anon;
grant execute on function public.book_bank_exact_matches(uuid, jsonb) to authenticated, service_role;

create or replace function public.undo_bank_exact_match_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public._r2677_exact_gate();
  v_run    public.bank_exact_match_runs;
  v_l      record;
  v_n      integer := 0;
  v_left   jsonb := '[]'::jsonb;
begin
  select * into v_run from public.bank_exact_match_runs r where r.id = p_run_id and r.tenant_id = v_tenant for update;
  if not found then
    raise exception 'This match run is not in your company — reload the page.' using errcode = 'no_data_found';
  end if;

  for v_l in
    select l.id, l.bank_txn_id, l.kind, l.amount, l.matched_to_type as want_type, l.matched_to_id as want_id,
           l.matched_at as want_at, t.txn_date, t.matched_to_type as now_type, t.matched_to_id as now_id, t.matched_at as now_at
      from public.bank_exact_match_run_lines l
      join public.bank_transactions t on t.id = l.bank_txn_id and t.tenant_id = v_tenant
     where l.run_id = p_run_id and l.undone_at is null
     order by t.txn_date, l.bank_txn_id
     for update of l, t
  loop
    /* Exactly the run's match: same type, same record and the same matched_at (a hand re-match of
       the same line later is NOT the run's, and is left alone). */
    if v_l.now_type is distinct from v_l.want_type or v_l.now_id is distinct from v_l.want_id
       or v_l.now_at is distinct from v_l.want_at then
      update public.bank_exact_match_run_lines
         set undone_at = now(), undo_note = 'Released: changed by hand since the run — left as it is.'
       where id = v_l.id;
      v_left := v_left || jsonb_build_object('txn_id', v_l.bank_txn_id, 'txn_date', v_l.txn_date, 'amount', v_l.amount,
        'reason', 'Changed since the run (un-reconciled or matched again by hand) — left as it is.');
      continue;
    end if;
    begin
      /* Never through a path that deletes a receipt: the run never matched an advance receipt. */
      if v_l.now_type = 'payment' and public.bank_advance_payment(public.bank_match_uuid(v_l.now_id)) then
        raise exception 'This receipt is a customer advance — un-reconcile it from the line instead.' using errcode = 'check_violation';
      end if;
      perform public.unreconcile_bank_receipt(v_l.bank_txn_id, false);
      if exists (select 1 from public.bank_transactions t where t.id = v_l.bank_txn_id and t.matched_to_type is not null) then
        raise exception 'The line stayed reconciled — left as it is.' using errcode = 'check_violation';
      end if;
      update public.bank_exact_match_run_lines set undone_at = now(), undo_note = 'Undone.' where id = v_l.id;
      v_n := v_n + 1;
    exception when others then
      v_left := v_left || jsonb_build_object('txn_id', v_l.bank_txn_id, 'txn_date', v_l.txn_date, 'amount', v_l.amount, 'reason', sqlerrm);
    end;
  end loop;

  if v_run.undone_at is null
     and not exists (select 1 from public.bank_exact_match_run_lines l where l.run_id = p_run_id and l.undone_at is null) then
    update public.bank_exact_match_runs set undone_at = now(), undone_by = public.current_user_id() where id = p_run_id;
  end if;
  return jsonb_build_object('run_id', p_run_id, 'undone', v_n, 'left', v_left);
end;
$function$;
revoke all on function public.undo_bank_exact_match_run(uuid) from public, anon;
grant execute on function public.undo_bank_exact_match_run(uuid) to authenticated, service_role;

comment on table public.bank_exact_match_runs is
  'R-2677: one "Match all exact" run on Banking → an account (filter, who, when, how many matched; undone_at once Undo this run took every line back).';
comment on table public.bank_exact_match_run_lines is
  'R-2677: one bank line a "Match all exact" run matched to an EXISTING record (receipt, project receipt, paid expense, recorded vendor payment) — and the line''s match right after, so Undo touches only that.';

commit;
