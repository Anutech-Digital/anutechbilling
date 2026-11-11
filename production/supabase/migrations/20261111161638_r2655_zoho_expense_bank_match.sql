-- deploy-peek: to_regprocedure('public.zoho_expense_bank_matches(uuid)') is not null and to_regprocedure('public._r2655_match_gate()') is not null
-- deploy-key: r2655zohoexpensebankmatch
--
-- R-2655 (11 Nov 2026, p0 paisa, G-RECON plan N6) — PART 1: the preview. After the Zoho FY purchase
-- import (R-2502) the imported expenses that Zoho paid from a bank / card account are in the books as
-- PAID, with the app account they were paid from, but not yet tied to their statement line. If the
-- statement debit is then booked as a NEW expense, the cost and its input GST are in the books twice.
--
-- ─── CHECK FIRST (card): does Auto-reconcile already do this? Only partly ────────────────────
--   auto_reconcile_bank_account tries (1) bank_debit_vendor_auto_match (R-1911 recorded payment): it
--   needs the vendor GUESSED from the narration and ONE expense row equal to the debit; then
--   (2) suggest_bank_transaction_matches: expenses.amount = the debit within 3 days — any account.
--   Missed: a narration that does not name the vendor (card / UPI / POS); a Zoho document imported as
--   2+ category rows (the debit is their SUM); a TDS expense on path 2 (cash = amount − TDS); a Zoho
--   date more than 3 days from the bank date; and path 2 does not look at the paid-from account.
--
-- ─── WHAT THIS ADDS (read only — no table, no write) ─────────────────────────────────────────
--   zoho_expense_bank_matches(account default null) — one row per (Zoho document, bank line) pair, or
--   one row for a document with no pair. A DOCUMENT = every expenses row with the same zoho_doc_id
--   (its category parts); its cash = Σ (amount − tds_amount − advance_applied − paid_amount) of its
--   open parts — the R-1911 "recorded payment" cash, same filters (paid, not banked, INR, not
--   Salaries, not cash / payroll / statutory / reimbursement / emi / advance, no prepaid advance, no
--   recorded_payment line yet). Only a document paid from a non-cash account of the company.
--   A LINE = an open (not reconciled) money-out line of THAT account with debit = the cash, within 7
--   days of the paid date — or within 60 days when the line's own UTR / RRN (ref_key, 10+ characters)
--   is the Zoho reference (the vendor payment's, else the Zoho expense's own; bank_ref_matches, R-2534).
--   status:
--     'sure'      — the document has exactly ONE such line and the line exactly ONE such document
--                   (fail closed). When several are possible but exactly one shares the reference
--                   (6+ characters — a cheque number counts), that one is the pair.
--     'ambiguous' — more than one possible on either side, or a hand-recorded (non-Zoho) paid
--                   expense of the same cash, not banked, within 7 days could be this line too.
--     'look'      — every part of the document is not open the same way (some banked by hand, other
--                   account / paid date), or the only debit is ₹1 apart (S1: the same money, but a
--                   recorded payment is matched only at its exact cash).
--     'booked_elsewhere' — no open line, and a debit of the same amount within 7 days is ALREADY
--                   reconciled as something else: the expense may be in the books twice (R-2629's
--                   double-pay rule). Listed for the owner; nothing here touches a reconciled line.
--     'locked'    — the line or the paid date is on or before the books lock.
--     'no_line'   — no open debit of that amount in the window (the nearest one outside it is named).
--   GST "returns filed up to" (G12 / R-2631) is NOT a reason to hold a match back: tying a paid
--   expense to its statement line writes no GST document and moves no date.
--   Owner / accountant only (as the R-2535 / R-2656 runs), own company only.
-- Booking the sure ones (reconcile_bank_debit_to_vendor {source: recorded_payment}, run id, Undo this
-- run) is PART 2 — card R-2655b. This file changes no stored data.
-- Test: supabase/tests/r2655_zoho_expense_bank_match.test.sql (begin … rollback; red without this file).
begin;

/* The gate: a signed-in owner / accountant of a company. Returns the company. */
create or replace function public._r2655_match_gate()
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
    raise exception 'Only an owner or accountant can match imported Zoho expenses to bank lines' using errcode = '42501';
  end if;
  return v_tenant;
end;
$function$;
revoke all on function public._r2655_match_gate() from public, anon;
grant execute on function public._r2655_match_gate() to authenticated, service_role;

create or replace function public.zoho_expense_bank_matches(p_account_id uuid default null)
returns table(
  status text, reason text,
  zoho_doc_id text, vendor_id uuid, vendor_name text, bill_no text, categories text,
  doc_date date, paid_on date, cash integer, parts integer, expense_ids text[], reference text,
  account_id uuid, account text,
  txn_id uuid, txn_date date, txn_description text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_tenant uuid := public._r2655_match_gate(); v_lock date;
begin
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;
  return query
  with legs as (
    select e.id, e.zoho_doc_id as zdoc, e.zoho_leg, e.vendor_id, e.vendor_name, e.bill_no, e.category, e.expense_date,
           e.bank_account_id, coalesce(e.paid_date, e.expense_date) as paid_on,
           e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) as cash,
           /* an open "recorded payment" — the R-1911 (b) list, part for part */
           (e.paid = true and e.reconciled_txn_id is null
            and upper(coalesce(e.currency, 'INR')) = 'INR'
            and e.category <> 'Salaries'
            and lower(coalesce(e.payment_method, '')) not in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
            and e.prepaid_advance_id is null
            and e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0
            and not exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id and l.kind = 'recorded_payment')
           ) as is_open
      from public.expenses e
     where e.tenant_id = v_tenant and e.zoho_doc_id is not null
  ),
  docs0 as (
    select g.zdoc,
           count(*)::integer as n_legs,
           (count(*) filter (where g.is_open))::integer as n_open,
           count(distinct g.bank_account_id) filter (where g.is_open) as n_acc,
           count(distinct g.paid_on) filter (where g.is_open) as n_days,
           (array_agg(g.bank_account_id order by g.zoho_leg) filter (where g.is_open))[1] as acc,
           (array_agg(g.paid_on order by g.zoho_leg) filter (where g.is_open))[1] as paid_on,
           (coalesce(sum(g.cash) filter (where g.is_open), 0))::integer as cash,
           (array_agg(g.vendor_id order by g.zoho_leg))[1] as vendor_id,
           (array_agg(g.vendor_name order by g.zoho_leg))[1] as vendor_name,
           (array_agg(g.bill_no order by g.zoho_leg))[1] as bill_no,
           min(g.expense_date) as doc_date,
           string_agg(distinct g.category, ', ') as cats,
           array_agg(g.id order by g.zoho_leg) filter (where g.is_open) as ids
      from legs g
     group by g.zdoc
  ),
  docs as (
    select d.*, a.name as acc_name,
           (d.n_open = d.n_legs and d.n_acc = 1 and d.n_days = 1) as whole,
           /* The bank's reference as Zoho has it: the vendor payment that paid the bill (R-2502 link),
              else the Zoho expense's own reference. A bill's own reference is a bill note, not a UTR. */
           nullif(btrim(coalesce(
             (select s.payload->>'reference'
                from public.zoho_vendor_payment_links k
                join public.zoho_fy_scan s on s.tenant_id = k.tenant_id and s.kind = 'vendorpayments' and s.zoho_id = k.zoho_payment_id
               where k.tenant_id = v_tenant and k.target_type = 'expense' and k.target_ids && d.ids
                 and nullif(btrim(s.payload->>'reference'), '') is not null
               order by k.created_at, k.id limit 1),
             case when d.zdoc like 'expenses:%' then
               (select s.payload->>'reference' from public.zoho_fy_scan s
                 where s.tenant_id = v_tenant and s.kind = 'expenses' and s.zoho_id = substr(d.zdoc, 10))
             end, '')), '') as ref
      from docs0 d
      join public.bank_accounts a on a.id = d.acc and a.tenant_id = v_tenant
     where d.n_open > 0 and d.cash > 0
       and coalesce(a.account_type::text, '') <> 'cash'
       and (p_account_id is null or d.acc = p_account_id)
  ),
  lines as (
    select bt.id, bt.bank_account_id, bt.txn_date, bt.description, bt.ref_key, bt.matched_to_type,
           coalesce(bt.debit, 0) as dr
      from public.bank_transactions bt
     where bt.tenant_id = v_tenant
       and bt.bank_account_id in (select d.acc from docs d)
       and coalesce(bt.debit, 0) > 0 and coalesce(bt.credit, 0) = 0
  ),
  cand as (
    select d.zdoc, l.id as lid, l.txn_date, l.description,
           /* NULL never reads as a match (R-2656 lesson): coalesce to false */
           coalesce(length(public.bank_ref_norm(l.ref_key)) >= 6 and public.bank_ref_matches(d.ref, l.ref_key), false) as by_ref
      from docs d
      join lines l on l.bank_account_id = d.acc and l.matched_to_type is null and l.dr = d.cash
     where d.whole
       and (abs(l.txn_date - d.paid_on) <= 7
            or (abs(l.txn_date - d.paid_on) <= 60
                and coalesce(length(public.bank_ref_norm(l.ref_key)) >= 10 and public.bank_ref_matches(d.ref, l.ref_key), false)))
  ),
  per_doc as (select c.zdoc, count(*) as n_all, count(*) filter (where c.by_ref) as n_ref from cand c group by c.zdoc),
  per_line as (select c.lid, count(*) as n_all, count(*) filter (where c.by_ref) as n_ref from cand c group by c.lid),
  judged as (
    select c.*,
           (case when pd.n_ref > 0 then (c.by_ref and pd.n_ref = 1) else pd.n_all = 1 end)
           and (case when pl.n_ref > 0 then (c.by_ref and pl.n_ref = 1) else pl.n_all = 1 end) as only_one,
           (case when pd.n_ref > 0 then c.by_ref else true end)
           and (case when pl.n_ref > 0 then c.by_ref else true end) as in_play,
           greatest(pd.n_all, pl.n_all) as n_max
      from cand c
      join per_doc pd on pd.zdoc = c.zdoc
      join per_line pl on pl.lid = c.lid
  ),
  pairs as (
    select d.zdoc, j.lid, j.txn_date, j.description, j.by_ref, j.only_one, j.n_max,
           /* a hand-recorded (non-Zoho) paid expense of the same cash, not banked, that this line could be */
           exists (select 1 from public.expenses r
                    where r.tenant_id = v_tenant and r.zoho_doc_id is null
                      and r.paid = true and r.reconciled_txn_id is null
                      and (r.bank_account_id is null or r.bank_account_id = d.acc)
                      and upper(coalesce(r.currency, 'INR')) = 'INR' and r.category <> 'Salaries'
                      and lower(coalesce(r.payment_method, '')) not in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
                      and r.prepaid_advance_id is null
                      and r.amount - coalesce(r.tds_amount, 0) - coalesce(r.advance_applied, 0) - coalesce(r.paid_amount, 0) = d.cash
                      and abs(coalesce(r.paid_date, r.expense_date) - j.txn_date) <= 7
                      and not exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = r.id and l.kind = 'recorded_payment')
                  ) as rival
      from judged j
      join docs d on d.zdoc = j.zdoc
     where j.in_play
  ),
  paired as (
    select d.*, p.lid, p.txn_date as l_date, p.description as l_desc,
           case when p.only_one is not true or p.rival then 'ambiguous'
                when v_lock is not null and least(p.txn_date, d.paid_on) <= v_lock then 'locked'
                else 'sure' end as st,
           case when p.only_one is not true then
                  format('%s documents / debits of this amount could pair here — nothing is matched when there is more than one. Match it on the bank line.', p.n_max)
                when p.rival then
                  'Another paid expense of the same amount (not from Zoho, not reconciled yet) could be this debit too. Match it on the bank line.'
                when v_lock is not null and least(p.txn_date, d.paid_on) <= v_lock then
                  format('Books are locked up to %s.', to_char(v_lock, 'DD Mon YYYY'))
                else
                  case when p.by_ref then 'Same bank reference as in Zoho, same amount' else 'Same amount' end
                  || format(', paid from this account, %s day(s) apart, the only open debit and the only Zoho document that fit.', abs(p.txn_date - d.paid_on))
           end as why
      from pairs p
      join docs d on d.zdoc = p.zdoc
  ),
  alone as (
    /* a document with no pair in play: say why */
    select d.*, x.lid, x.l_date, x.l_desc, x.st, x.why
      from docs d
      cross join lateral (
        select * from (
          /* 0. its parts are not all open the same way */
          select 0 as pri, null::uuid as lid, null::date as l_date, null::text as l_desc, 'look'::text as st,
                 format('%s of its %s parts are open, or its parts were paid from different accounts / dates — it was changed by hand. Match it on the bank line.', d.n_open, d.n_legs) as why
           where not d.whole
          union all
          /* 1. the same-amount debit is already reconciled as something else */
          select 1, b.id, b.txn_date, b.description, 'booked_elsewhere',
                 format('A debit of the same amount on %s is already reconciled as %s. If that is this payment, the expense is in the books twice — check it.',
                        to_char(b.txn_date, 'DD Mon YYYY'), replace(b.matched_to_type, '_', ' '))
            from (select l.* from lines l
                   where l.bank_account_id = d.acc and l.matched_to_type is not null and l.dr = d.cash
                     and abs(l.txn_date - d.paid_on) <= 7
                   order by abs(l.txn_date - d.paid_on), l.id limit 1) b
           where d.whole
          union all
          /* 2. an open debit ₹1 apart */
          select 2, n.id, n.txn_date, n.description, 'look',
                 'The debit is ₹1 apart from what Zoho paid — the same money, but it is not matched automatically. Match it on the bank line.'
            from (select l.* from lines l
                   where l.bank_account_id = d.acc and l.matched_to_type is null and abs(l.dr - d.cash) = 1
                     and abs(l.txn_date - d.paid_on) <= 7
                   order by abs(l.txn_date - d.paid_on), l.id limit 1) n
           where d.whole
          union all
          /* 3. an open same-amount debit outside the window */
          select 3, f.id, f.txn_date, f.description, 'no_line',
                 format('No open debit of this amount within 7 days of %s. The nearest one is on %s (%s days away) — check it is the same payment and match it on the bank line.',
                        to_char(d.paid_on, 'DD Mon YYYY'), to_char(f.txn_date, 'DD Mon YYYY'), abs(f.txn_date - d.paid_on))
            from (select l.* from lines l
                   where l.bank_account_id = d.acc and l.matched_to_type is null and l.dr = d.cash
                     and abs(l.txn_date - d.paid_on) between 8 and 60
                   order by abs(l.txn_date - d.paid_on), l.id limit 1) f
           where d.whole
          union all
          /* 4. nothing */
          select 4, null::uuid, null::date, null::text, 'no_line',
                 format('No open debit of this amount within 7 days of %s in this account — is the statement imported up to that date?',
                        to_char(d.paid_on, 'DD Mon YYYY'))
           where d.whole
        ) y order by y.pri limit 1
      ) x
     where not exists (select 1 from pairs p where p.zdoc = d.zdoc)
  )
  select r.st, r.why, r.zdoc, r.vendor_id, r.vendor_name, r.bill_no, r.cats,
         r.doc_date, r.paid_on, r.cash, r.n_open, r.ids, r.ref,
         r.acc, r.acc_name, r.lid, r.l_date, r.l_desc
    from (select * from paired union all select * from alone) r
   order by case r.st when 'sure' then 0 when 'ambiguous' then 1 when 'look' then 2 when 'booked_elsewhere' then 3
                      when 'locked' then 4 else 5 end,
            r.paid_on, r.zdoc, r.lid;
end;
$function$;
revoke all on function public.zoho_expense_bank_matches(uuid) from public, anon;
grant execute on function public.zoho_expense_bank_matches(uuid) to authenticated, service_role;
comment on function public.zoho_expense_bank_matches(uuid) is
  'R-2655 (read only): Zoho-imported paid expenses (by zoho_doc_id, paid from a bank / card account) against the open debits of that account — sure / ambiguous / look / booked_elsewhere / locked / no_line with the reason. Owner / accountant, own company.';

commit;
