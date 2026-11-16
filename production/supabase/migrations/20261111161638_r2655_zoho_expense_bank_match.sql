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
--     'ambiguous' — more than one possible on either side, or something else recorded as paid could
--                   be this line too (R-1911's lists, ±30 days): another open paid expense of the same
--                   cash, or a Bills-page / payment-run payment (its stand-in manual line).
--     'look'      — every part of the document is not open the same way (some banked by hand, other
--                   account / paid date, no paid-from account); Zoho paid 2+ bills with ONE vendor
--                   payment (the debit is their total); the debit carries a UTR that is not the one
--                   Zoho has (both 10+ characters), or another document's reference; or the only debit
--                   is ₹1 apart (S1: the same money, but a recorded payment is matched at its exact cash).
--     'booked_elsewhere' — no open line, and a debit of the same amount within 7 days is ALREADY
--                   reconciled as something else (not as another Zoho document's own payment): the expense may be in the books twice (R-2629's
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
  with open_rows as (
    /* Every open "recorded payment" expense row of the company — the R-1911 (b) list, part for part,
       written ONCE here (the documents and their rivals both read it). */
    select e.id, e.zoho_doc_id as zdoc, e.bank_account_id, coalesce(e.paid_date, e.expense_date) as paid_on,
           e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) as cash
      from public.expenses e
     where e.tenant_id = v_tenant
       and e.paid = true and e.reconciled_txn_id is null
       and upper(coalesce(e.currency, 'INR')) = 'INR'
       and e.category <> 'Salaries'
       and lower(coalesce(e.payment_method, '')) not in ('cash', 'payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
       and e.prepaid_advance_id is null
       and e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0
       and not exists (select 1 from public.bank_vendor_payment_lines l where l.expense_id = e.id and l.kind = 'recorded_payment')
  ),
  legs as (
    select e.id, e.zoho_doc_id as zdoc, e.zoho_leg, e.vendor_id, e.vendor_name, e.bill_no, e.category, e.expense_date,
           o.bank_account_id, o.paid_on, o.cash, (o.id is not null) as is_open
      from public.expenses e
      left join open_rows o on o.id = e.id
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
  docs1 as (
    select d.*, a.name as acc_name,
           /* every part open the same way, paid from ONE known account */
           (d.n_open = d.n_legs and d.n_acc = 1 and d.n_days = 1 and a.id is not null) as whole,
           /* Zoho paid 2+ bills with this one vendor payment: the debit is their TOTAL, never this bill's own cash */
           coalesce(pay.n_bills, 1) as n_bills,
           /* The bank's reference as Zoho has it: the vendor payment that paid the bill (R-2502 link),
              else the Zoho expense's own reference. A bill's own reference is a bill note, not a UTR. */
           nullif(btrim(coalesce(
             (select nullif(btrim(s.payload->>'reference'), '') from public.zoho_fy_scan s
               where s.tenant_id = v_tenant and s.kind = 'vendorpayments' and s.zoho_id = pay.zoho_payment_id),
             case when d.zdoc like 'expenses:%' then
               (select s.payload->>'reference' from public.zoho_fy_scan s
                 where s.tenant_id = v_tenant and s.kind = 'expenses' and s.zoho_id = substr(d.zdoc, 10))
             end, '')), '') as ref
      from docs0 d
      left join public.bank_accounts a on a.id = d.acc and a.tenant_id = v_tenant
      left join lateral (
        select k.zoho_payment_id,
               (select count(distinct k2.zoho_bill_id) from public.zoho_vendor_payment_links k2
                 where k2.tenant_id = v_tenant and k2.zoho_payment_id = k.zoho_payment_id) as n_bills
          from public.zoho_vendor_payment_links k
         where k.tenant_id = v_tenant and k.target_type = 'expense' and k.target_ids && d.ids
         order by k.created_at, k.id limit 1
      ) pay on true
     where d.n_open > 0 and d.cash > 0
       and coalesce(a.account_type::text, '') <> 'cash'
       and (p_account_id is null or d.acc = p_account_id)
  ),
  docs as (
    select d.*,
           /* the Zoho reference when it is shaped like a UTR / RRN (10–22 characters, 6+ digits) */
           case when length(public.bank_ref_norm(d.ref)) between 10 and 22
                 and length(regexp_replace(public.bank_ref_norm(d.ref), '[^0-9]', '', 'g')) >= 6
                then public.bank_ref_norm(d.ref) end as ref_utr
      from docs1 d
  ),
  lines as (
    /* Statement debits of the documents' accounts with a document's cash (±₹1). Never the app's own
       stand-in line of a payment recorded on the Bills page / a payment run (source 'manual' matched
       to a bill / expense) — that is not a bank debit; it counts as a rival below. */
    select bt.id, bt.bank_account_id, bt.txn_date, bt.description, bt.ref_key, bt.matched_to_type,
           coalesce(bt.debit, 0) as dr
      from public.bank_transactions bt
     where bt.tenant_id = v_tenant
       and coalesce(bt.debit, 0) > 0 and coalesce(bt.credit, 0) = 0
       and not (bt.source = 'manual' and coalesce(bt.matched_to_type, '') in ('vendor_bill', 'expense'))
       and exists (select 1 from docs d where d.acc = bt.bank_account_id and abs(coalesce(bt.debit, 0) - d.cash) <= 1)
  ),
  cand as (
    select d.zdoc, l.id as lid, l.txn_date, l.description,
           /* NULL never reads as a match (R-2656 lesson): coalesce to false */
           coalesce(length(public.bank_ref_norm(l.ref_key)) >= 6 and public.bank_ref_matches(d.ref, l.ref_key), false) as by_ref,
           /* both sides carry a UTR / RRN and they are NOT the same: another payment */
           coalesce(d.ref_utr is not null and length(public.bank_ref_norm(l.ref_key)) >= 10
                    and not public.bank_ref_matches(d.ref, l.ref_key), false) as ref_clash
      from docs d
      join lines l on l.bank_account_id = d.acc and l.matched_to_type is null and l.dr = d.cash
     where d.whole and d.n_bills = 1
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
    select d.zdoc, j.lid, j.txn_date, j.description, j.by_ref, j.ref_clash, j.only_one, j.n_max,
           /* Something else recorded as paid that this debit could be (R-1911's two lists, ±30 days as
              bank_debit_vendor_auto_match): (b) another open paid expense of the same cash — from Zoho
              or not — that is not already counted as a candidate of this line; (a) a payment recorded
              on the Bills page / a payment run (its stand-in manual line) of the same amount. */
           (exists (select 1 from open_rows r
                     where r.cash = d.cash
                       and (r.bank_account_id is null or r.bank_account_id = d.acc)
                       and abs(r.paid_on - j.txn_date) <= 30
                       and (r.zdoc is null
                            or (r.zdoc <> d.zdoc
                                and not exists (select 1 from cand c2 where c2.zdoc = r.zdoc and c2.lid = j.lid))))
            or exists (select 1 from public.bank_transactions m
                        where m.tenant_id = v_tenant and m.bank_account_id = d.acc
                          and m.source = 'manual' and m.matched_to_type in ('vendor_bill', 'expense')
                          and coalesce(m.debit, 0) = d.cash and abs(m.txn_date - j.txn_date) <= 30)
           ) as rival
      from judged j
      join docs d on d.zdoc = j.zdoc
     where j.in_play
  ),
  paired as (
    select d.*, p.lid, p.txn_date as l_date, p.description as l_desc,
           case when p.only_one is not true or p.rival then 'ambiguous'
                when v_lock is not null and least(p.txn_date, d.paid_on) <= v_lock then 'locked'
                when p.ref_clash then 'look'
                else 'sure' end as st,
           case when p.only_one is not true then
                  format('%s documents / debits of this amount could pair here — nothing is matched when there is more than one. Match it on the bank line.', p.n_max)
                when p.rival then
                  'Another paid expense of the same amount (not reconciled yet), or a payment recorded on the Bills page, could be this debit too. Match it on the bank line.'
                when v_lock is not null and least(p.txn_date, d.paid_on) <= v_lock then
                  format('Books are locked up to %s.', to_char(v_lock, 'DD Mon YYYY'))
                when p.ref_clash then
                  'Same amount, but the bank reference on the debit is not the one Zoho has for this payment — it may be another payment. Check it and match it on the bank line.'
                else
                  case when p.by_ref then 'Same bank reference as in Zoho, same amount' else 'Same amount' end
                  || format(', paid from this account, %s day(s) apart, the only open debit and the only Zoho document that fit.', abs(p.txn_date - d.paid_on))
           end as why
      from pairs p
      join docs d on d.zdoc = p.zdoc
  ),
  alone as (
    /* a document with no pair in play: say why (the first that applies) */
    select d.*, x.lid, x.l_date, x.l_desc, x.st, x.why
      from docs d
      cross join lateral (
        select * from (
          /* 0. its parts are not all open the same way, or it has no paid-from account */
          select 0 as pri, null::uuid as lid, null::date as l_date, null::text as l_desc, 'look'::text as st,
                 case when d.acc is null then
                        'Marked paid with no paid-from account — it cannot be matched to an account''s lines here. Match it on the bank line.'
                      else format('%s of its %s parts are open, or its parts were paid from different accounts / dates — it was changed by hand. Match it on the bank line.', d.n_open, d.n_legs)
                 end as why
           where not d.whole
          union all
          /* 1. Zoho paid several bills with one payment */
          select 1, null::uuid, null::date, null::text, 'look',
                 format('Zoho paid this bill together with %s other bill(s) in one payment — the bank debit is their total, not this amount. Match it on the bank line.', d.n_bills - 1)
           where d.whole and d.n_bills > 1
          union all
          /* 2. its only open debit carries another Zoho document's reference */
          select 2, t.lid, t.txn_date, t.description, 'look',
                 'The open debit of this amount carries the bank reference of another Zoho document — it belongs to that one.'
            from (select c.* from cand c where c.zdoc = d.zdoc order by abs(c.txn_date - d.paid_on), c.lid limit 1) t
          union all
          /* 3. the same-amount debit is already reconciled as something else — not as a Zoho document's
                own recorded payment (a sibling document matched correctly is not a double expense) */
          select 3, b.id, b.txn_date, b.description, 'booked_elsewhere',
                 format('A debit of the same amount on %s is already reconciled as %s. If that is this payment, the expense is in the books twice — check it.',
                        to_char(b.txn_date, 'DD Mon YYYY'), replace(b.matched_to_type, '_', ' '))
            from (select l.* from lines l
                   where l.bank_account_id = d.acc and l.matched_to_type is not null and l.dr = d.cash
                     and abs(l.txn_date - d.paid_on) <= 7
                     and not exists (select 1 from public.expenses z
                                      where z.tenant_id = v_tenant and z.zoho_doc_id is not null and z.reconciled_txn_id = l.id)
                     and not exists (select 1 from public.bank_vendor_payment_lines pl
                                      join public.expenses z on z.id = pl.expense_id and z.tenant_id = v_tenant
                                     where pl.bank_txn_id = l.id and pl.kind = 'recorded_payment' and z.zoho_doc_id is not null)
                   order by abs(l.txn_date - d.paid_on), l.id limit 1) b
           where d.whole and d.n_bills = 1
          union all
          /* 4. an open debit ₹1 apart */
          select 4, n.id, n.txn_date, n.description, 'look',
                 'The debit is ₹1 apart from what Zoho paid — the same money, but it is not matched automatically. Match it on the bank line.'
            from (select l.* from lines l
                   where l.bank_account_id = d.acc and l.matched_to_type is null and abs(l.dr - d.cash) = 1
                     and abs(l.txn_date - d.paid_on) <= 7
                   order by abs(l.txn_date - d.paid_on), l.id limit 1) n
           where d.whole and d.n_bills = 1
          union all
          /* 5. an open same-amount debit outside the window */
          select 5, f.id, f.txn_date, f.description, 'no_line',
                 format('No open debit of this amount within 7 days of %s. The nearest one is on %s (%s days away) — check it is the same payment and match it on the bank line.',
                        to_char(d.paid_on, 'DD Mon YYYY'), to_char(f.txn_date, 'DD Mon YYYY'), abs(f.txn_date - d.paid_on))
            from (select l.* from lines l
                   where l.bank_account_id = d.acc and l.matched_to_type is null and l.dr = d.cash
                     and abs(l.txn_date - d.paid_on) between 8 and 60
                   order by abs(l.txn_date - d.paid_on), l.id limit 1) f
           where d.whole and d.n_bills = 1
          union all
          /* 6. nothing */
          select 6, null::uuid, null::date, null::text, 'no_line',
                 format('No open debit of this amount within 7 days of %s in this account — is the statement imported up to that date?',
                        to_char(d.paid_on, 'DD Mon YYYY'))
           where d.whole and d.n_bills = 1
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
