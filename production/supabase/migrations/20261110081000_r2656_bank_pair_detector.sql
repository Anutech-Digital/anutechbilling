-- deploy-peek: to_regclass('public.bank_pair_run_lines') is not null and to_regprocedure('public.bank_pair_candidates(uuid)') is not null and to_regprocedure('public.book_bank_pairs(jsonb)') is not null and to_regprocedure('public.undo_bank_pair_run(uuid)') is not null
-- deploy-key: r2656bankpairdetector
--
-- R-2656 (10 Nov 2026, p1 paisa, G-RECON plan N3 — RECON-SPEED research §3 item 4). FD / sweep / OD /
-- credit-card transfers between the company's own accounts and same-account reversals (REV / RET /
-- UPIRET / I/W CHQ RET) were booked by hand one line at a time (~20 an hour; 33 + 16 lines on HDFC 4523).
-- This file FINDS those pairs, books only the sure ones through the existing paths, under a run id that
-- can be undone.
--
-- ─── WHAT THIS ADDS ───────────────────────────────────────────────────────────
--   bank_pair_runs / bank_pair_run_lines — one row per run (company, who, when, undone) and one per pair
--     the run booked, with each line's matched_at at booking (Undo touches only that booking). A line sits
--     in at most one live (not undone) run pair (partial unique indexes); a run pair whose lines were
--     un-reconciled by hand is released when Book or Undo meets it.
--     RLS: a company reads only its own; nobody writes them directly (only the functions below).
--   bank_pair_candidates(account default null) — read only. Every pair of two OPEN lines (not matched,
--     one side only, amount > 0) with the same amount, opposite sides, at most 3 days apart:
--       kind 'transfer' — the two lines are in two different accounts of the company;
--       kind 'reversal' — the two lines are in the same account.
--     A pair is shown only when it has a reason (reviews 10 Nov: plain TRANSFER / TRF / CC / OD / SELF,
--     a word on only ONE of two current accounts, and REFUND on a FIRST line are all on ordinary
--     third-party lines — "CHQ PAID-SELF" vs "NEFT CR-ACME", "NEFT DR-VENDOR RENT" vs "FD CLOSURE" —
--     so they are NOT reasons):
--       transfer: both lines carry the same bank reference (UTR / RRN, 10+ characters); or BOTH lines
--                 have an own-transfer word (SWEEP, FD, FDR, FIXED DEPOSIT, CREDIT CARD, CC PAYMENT,
--                 CARD PAYMENT, OWN A/C — bank_pair_fd_word / bank_pair_card_word / bank_pair_transfer_word);
--                 or one line has an FD / sweep word and the OTHER line is in a fixed-deposit account,
--                 a card-payment word and the other line is in a credit-card account, or OD / OVERDRAFT
--                 and the other line is in an overdraft account;
--       reversal: both lines carry the same UTR / RRN (10+ characters); or the LATER line (either line on
--                 the same day) has a reversal word (REV, REVERSAL, RET, RETURN, RTN, REFUND, UPIRET …)
--                 AND the two lines share the cheque no. (ref_key) or an 8+ digit / UTR reference written in
--                 both narrations (bank_pair_shared_ref), or carry the SAME full payee name
--                 (bank_pair_payee: 2+ words left after rail / IFSC / payment-app / company-suffix words).
--                 A reversal word with anything less is status 'check' — listed, never booked. Re-check
--                 10 Nov (proven): a shared app name (PHONEPE) or IFSC (HDFC0000240) or "TECHNOLOGIES" is
--                 NOT the same party — "UPI-PHONEPE-SWIGGY" vs "UPI REFUND-PHONEPE-AMAZON" is a 'check'.
--     status 'sure'  — each of the two lines has exactly ONE possible partner (fail closed: two or more
--                      → 'ambiguous', nothing booked). Counted over EVERY open same-amount opposite line
--                      ≤3 days (with or without a reason), in any account. For a reversal, when several
--                      lines are possible but exactly one shares the line's bank reference (a cheque no.
--                      counts here: three ₹5L cheques returned the same day pair by cheque number), that
--                      one is the partner — it still needs its reason above. A transfer never narrows:
--                      reconcile_bank_txn_as_transfer picks the nearest open line of the other account
--                      itself, so a transfer is sure only when there is no other line it could pick.
--            'ambiguous' — more than one possible partner on either side.
--            'check'     — a one-to-one reversal with a reversal word only (no shared name / reference).
--            'locked'    — a line is on or before the company's books lock date.
--            'other_side_booked' — an open line with a reversal word whose same-amount opposite line in
--                      that account (≤3 days) is ALREADY reconciled, and which has no open partner: never
--                      booked or un-booked here (decision A5, 5 Nov: a data repair) — listed for the owner.
--     The reason column says why in plain words.
--   book_bank_pairs(pairs jsonb [{out_txn_id, in_txn_id}]) — books ONLY pairs that bank_pair_candidates
--     says are 'sure' (read once per call; the browser's list is never trusted), each pair in its own
--     savepoint after locking both lines and checking they are still open (a line booked by hand since
--     the preview is skipped):
--       transfer → reconcile_bank_txn_as_transfer(out line, the other account) — and the line it matched
--                  must be the in line (nothing added), else the pair is rolled back and skipped;
--       reversal → reconcile_bank_txn_manual(out line, reason, in line) — the manual reversal pair.
--     Returns {run_id (null when nothing was booked), booked, skipped:[{out_txn_id,in_txn_id,reason}]}.
--     Pressing Book twice books nothing the second time.
--   undo_bank_pair_run(run) — every pair of the run still matched exactly as the run left it (type, the
--     partner, and the same matched_at) goes back through unreconcile_bank_receipt(out line, false) (the
--     line's own un-reconcile; the R-2095 / R-2361 triggers free the other side). A pair changed by hand
--     since is released from the run and listed; a refused one (books lock) stays in the run and is
--     listed. The run is marked undone when no pair of it is left. Run again → 0.
--   All four: owner / accountant only (as Reconcile from Zoho's runs, R-2535), own company only.
-- No money of its own: a transfer / reversal pair writes no sale, expense, GST, TDS or journal row.
-- Test: supabase/tests/r2656_bank_pair_detector.test.sql (begin … rollback; red without this file).
begin;

create table if not exists public.bank_pair_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  undone_at   timestamptz,
  undone_by   uuid
);
create index if not exists bank_pair_runs_tenant_idx on public.bank_pair_runs (tenant_id, created_at desc);

create table if not exists public.bank_pair_run_lines (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.bank_pair_runs(id) on delete cascade,
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  kind           text not null check (kind in ('transfer', 'reversal')),
  out_txn_id     uuid not null references public.bank_transactions(id) on delete cascade,
  in_txn_id      uuid not null references public.bank_transactions(id) on delete cascade,
  amount         integer not null check (amount > 0),
  out_matched_at timestamptz,
  in_matched_at  timestamptz,
  booked_at      timestamptz not null default now(),
  undone_at      timestamptz
);
create index if not exists bank_pair_run_lines_run_idx on public.bank_pair_run_lines (run_id);
create unique index if not exists bank_pair_run_lines_out_live on public.bank_pair_run_lines (out_txn_id) where undone_at is null;
create unique index if not exists bank_pair_run_lines_in_live on public.bank_pair_run_lines (in_txn_id) where undone_at is null;

alter table public.bank_pair_runs enable row level security;
alter table public.bank_pair_run_lines enable row level security;
drop policy if exists bank_pair_runs_read on public.bank_pair_runs;
create policy bank_pair_runs_read on public.bank_pair_runs for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists bank_pair_run_lines_read on public.bank_pair_run_lines;
create policy bank_pair_run_lines_read on public.bank_pair_run_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists zzz_service_role_all on public.bank_pair_runs;
create policy zzz_service_role_all on public.bank_pair_runs as permissive for all to service_role using (true) with check (true);
drop policy if exists zzz_service_role_all on public.bank_pair_run_lines;
create policy zzz_service_role_all on public.bank_pair_run_lines as permissive for all to service_role using (true) with check (true);
revoke all on public.bank_pair_runs, public.bank_pair_run_lines from public, anon;
grant select on public.bank_pair_runs, public.bank_pair_run_lines to authenticated, service_role;

/* The gate: a signed-in owner / accountant of a company. Returns the company. */
create or replace function public._r2656_pair_gate()
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
    raise exception 'Only an owner or accountant can book or undo transfer and reversal pairs' using errcode = '42501';
  end if;
  return v_tenant;
end;
$function$;
revoke all on function public._r2656_pair_gate() from public, anon;
grant execute on function public._r2656_pair_gate() to authenticated, service_role;

/* The words. Whole words only ("RET" is not inside "RETAIL"); the narration is upper-cased first.
   Not here on purpose: TRANSFER / TRF (SBI writes "BY TRANSFER" on every NEFT), CC, OD, TPT, OWN,
   SELF (a "CHQ PAID-SELF" is cash out, not a transfer to a bank account of ours). */
create or replace function public.bank_pair_fd_word(p_text text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select upper(coalesce(p_text, '')) ~ '(^|[^A-Z])(SWEEP|SWEEPIN|SWEEPOUT|FD|FDR)([^A-Z]|$)'
      or upper(coalesce(p_text, '')) ~ '(FIXED DEPOSIT|AUTO SWEEP)';
$function$;
grant execute on function public.bank_pair_fd_word(text) to authenticated, service_role;

create or replace function public.bank_pair_card_word(p_text text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select upper(coalesce(p_text, '')) ~ '(CREDIT CARD|CC PAYMENT|CARD PAYMENT)';
$function$;
grant execute on function public.bank_pair_card_word(text) to authenticated, service_role;

/* OD / OVERDRAFT counts ONLY when the other line is in an overdraft account (never on its own). */
create or replace function public.bank_pair_od_word(p_text text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select upper(coalesce(p_text, '')) ~ '(^|[^A-Z])(OD|OVERDRAFT)([^A-Z]|$)';
$function$;
grant execute on function public.bank_pair_od_word(text) to authenticated, service_role;

create or replace function public.bank_pair_transfer_word(p_text text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select public.bank_pair_fd_word(p_text) or public.bank_pair_card_word(p_text)
      or upper(coalesce(p_text, '')) ~ '(OWN A/C|OWN ACCOUNT)';
$function$;
grant execute on function public.bank_pair_transfer_word(text) to authenticated, service_role;

/* A reference number written in BOTH narrations: an all-digit token of 8+ digits (RRN, cheque / UTR
   digits), or a 12+ character token with 6+ digits that is not IFSC-shaped (a UTR). Dates and amounts
   (under 8 digits) and IFSC codes (HDFC0000240 — the same branch for many payees) never count. */
create or replace function public.bank_pair_shared_ref(p_a text, p_b text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select exists (
    select 1
      from regexp_split_to_table(upper(coalesce(p_a, '')), '[^A-Z0-9]+') t
     where (t ~ '^[0-9]{8,}$'
            or (length(t) >= 12 and length(regexp_replace(t, '[^0-9]', '', 'g')) >= 6
                and t !~ '^[A-Z]{4}0[A-Z0-9]{6}$'))
       and t = any (regexp_split_to_array(upper(coalesce(p_b, '')), '[^A-Z0-9]+'))
  );
$function$;
grant execute on function public.bank_pair_shared_ref(text, text) to authenticated, service_role;

/* The payee's name in a narration: its words in order, without rail / reversal / bank words,
   IFSC-shaped codes, payment apps and UPI handles (PHONEPE, PAYTM, GPAY, RAZORPAY, YBL …), company
   suffixes and generic words (PVT, LTD, TECHNOLOGIES, TRADERS, PAYMENT …), and any token with a
   digit. NULL when fewer than 2 words are left — one word ("SWIGGY", "SHARMA") is not a name. */
create or replace function public.bank_pair_payee(p_text text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case when count(*) >= 2 then string_agg(t, ' ' order by n) end
    from regexp_split_to_table(upper(coalesce(p_text, '')), '[^A-Z0-9]+') with ordinality as x(t, n)
   where length(t) >= 2
     and t !~ '[0-9]'
     and t not in (
       -- rails and statement words
       'UPI', 'UPIRET', 'UPIREV', 'NEFT', 'IMPS', 'RTGS', 'MMT', 'CHQ', 'CHEQUE', 'CHQRET', 'CLG',
       'CLEARING', 'ACH', 'ECS', 'NACH', 'POS', 'DR', 'CR', 'IW', 'OW', 'INW', 'INWARD', 'OUTWARD',
       'TPT', 'TRF', 'TRANSFER', 'PAID', 'PAY', 'PAYMENT', 'FUNDS', 'INSUFFICIENT', 'DRAWER',
       'SIGNATURE', 'DIFFERS', 'ORDER', 'OK', 'TO', 'FROM', 'BY', 'FOR', 'OF', 'THE', 'AND',
       'MS', 'MR', 'MRS', 'SMT', 'SHRI', 'CREDIT', 'DEBIT', 'MOBILE', 'INB', 'NETBANKING',
       -- reversal words
       'REV', 'REVERSAL', 'REVERSED', 'RET', 'RETURN', 'RETURNED', 'RTN', 'REFUND', 'REFUNDED',
       -- banks
       'BANK', 'HDFC', 'ICICI', 'SBI', 'SBIN', 'AXIS', 'UTIB', 'ICIC', 'KOTAK', 'KKBK', 'YES', 'YESB',
       'IDFC', 'INDUSIND', 'PNB', 'CANARA', 'BOB', 'FEDERAL', 'RBL', 'AU',
       -- payment apps, gateways and UPI handles
       'PHONEPE', 'PAYTM', 'GPAY', 'GOOGLE', 'GOOGLEPAY', 'BHIM', 'AMAZONPAY', 'RAZORPAY', 'CASHFREE',
       'PAYU', 'CRED', 'MOBIKWIK', 'BHARATPE', 'YBL', 'IBL', 'AXL', 'APL', 'OKICICI', 'OKSBI',
       'OKHDFCBANK', 'OKAXIS', 'PTYES', 'PTSBI', 'PTAXIS', 'PTHDFC', 'UPI',
       -- company suffixes and generic business words
       'PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'CO', 'COMPANY', 'INC', 'CORP', 'TECHNOLOGIES',
       'TECHNOLOGY', 'TECH', 'TRADERS', 'TRADING', 'ENTERPRISES', 'ENTERPRISE', 'SERVICES', 'SERVICE',
       'SOLUTIONS', 'SOLUTION', 'INDIA', 'INDUSTRIES', 'ASSOCIATES', 'GROUP', 'GLOBAL', 'INFOTECH',
       'SYSTEMS', 'DIGITAL', 'AGENCY', 'STORE', 'STORES', 'MART'
     );
$function$;
grant execute on function public.bank_pair_payee(text) to authenticated, service_role;

create or replace function public.bank_pair_reversal_word(p_text text)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select upper(coalesce(p_text, '')) ~ '(^|[^A-Z])(REV|REVERSAL|REVERSED|RET|RETURN|RETURNED|RTN|REFUND|REFUNDED|UPIRET|UPIREV|CHQRET)([^A-Z]|$)';
$function$;
grant execute on function public.bank_pair_reversal_word(text) to authenticated, service_role;

create or replace function public.bank_pair_candidates(p_account_id uuid default null)
returns table(
  kind text, status text, reason text, amount integer,
  out_txn_id uuid, out_account_id uuid, out_account text, out_date date, out_description text,
  in_txn_id uuid, in_account_id uuid, in_account text, in_date date, in_description text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_tenant uuid := public._r2656_pair_gate(); v_lock date;
begin
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;
  return query
  with lines as (
    select bt.id, bt.bank_account_id, bt.txn_date, bt.description, bt.ref_key, bt.matched_to_type,
           coalesce(bt.debit, 0) as dr, coalesce(bt.credit, 0) as cr, a.name as acc_name,
           coalesce(a.account_type::text, '') as acc_type
      from public.bank_transactions bt
      join public.bank_accounts a on a.id = bt.bank_account_id and a.tenant_id = v_tenant
     where bt.tenant_id = v_tenant
       and ((coalesce(bt.debit, 0) > 0 and coalesce(bt.credit, 0) = 0)
            or (coalesce(bt.credit, 0) > 0 and coalesce(bt.debit, 0) = 0))
  ),
  open_out as (select * from lines where matched_to_type is null and dr > 0),
  open_in  as (select * from lines where matched_to_type is null and cr > 0),
  raw as (
    select o.id as oid, i.id as iid,
           case when o.bank_account_id = i.bank_account_id then 'reversal' else 'transfer' end as k,
           /* any equal key (a cheque no. too) — only to tell same-account candidates apart */
           (o.ref_key is not null and o.ref_key = i.ref_key) as ref_any,
           /* a UTR / RRN — strong enough to be a reason by itself */
           (o.ref_key is not null and o.ref_key = i.ref_key and length(o.ref_key) >= 10) as ref_strong,
           o.dr as amt, o.txn_date as od, i.txn_date as idt,
           o.description as odesc, i.description as idesc,
           o.bank_account_id as oacc, i.bank_account_id as iacc, o.acc_name as oname, i.acc_name as iname,
           o.acc_type as otype, i.acc_type as itype
      from open_out o
      join open_in i on i.cr = o.dr and abs(i.txn_date - o.txn_date) <= 3 and i.id <> o.id
  ),
  w as (
    select r.*,
           /* transfer: the word must be backed by the OTHER line (its own word, or its account type) */
           (public.bank_pair_transfer_word(r.odesc) and public.bank_pair_transfer_word(r.idesc)) as tw_both,
           ((public.bank_pair_fd_word(r.odesc) and r.itype = 'fixed_deposit')
             or (public.bank_pair_fd_word(r.idesc) and r.otype = 'fixed_deposit')
             or (public.bank_pair_card_word(r.odesc) and r.itype = 'credit_card')
             or (public.bank_pair_card_word(r.idesc) and r.otype = 'credit_card')
             or (public.bank_pair_od_word(r.odesc) and r.itype = 'overdraft')
             or (public.bank_pair_od_word(r.idesc) and r.otype = 'overdraft')) as tw_account,
           /* reversal: the word is on the money coming back (the later line; either on the same day) */
           ((r.idt >= r.od and public.bank_pair_reversal_word(r.idesc))
             or (r.od >= r.idt and public.bank_pair_reversal_word(r.odesc))) as rw_later,
           public.bank_pair_shared_ref(r.odesc, r.idesc) as shared_ref,
           /* coalesce: a NULL here would make word_only NULL and slip a pair through as 'sure' */
           coalesce(public.bank_pair_payee(r.odesc) = public.bank_pair_payee(r.idesc), false) as same_payee
      from raw r
  ),
  q as (
    select w.*,
           case when w.k = 'transfer' then w.ref_strong or w.tw_both or w.tw_account
                else w.ref_strong or w.rw_later end as qualifies,
           /* a reversal word with no shared reference / name: shown for a person, never booked */
           coalesce(w.k = 'reversal' and not w.ref_strong and w.rw_later and not w.ref_any and not w.shared_ref and not w.same_payee, false) as word_only
      from w
  ),
  /* Each line's possible partners — every open same-amount opposite line ≤3 days, reason or not. A
     reversal narrows to the lines sharing its bank reference when there are such lines; a transfer
     never narrows (see the header). */
  per_out as (
    select q.oid, count(*) as n_all, count(*) filter (where q.k = 'reversal' and q.ref_any) as n_ref
      from q group by q.oid
  ),
  per_in as (
    select q.iid, count(*) as n_all, count(*) filter (where q.k = 'reversal' and q.ref_any) as n_ref
      from q group by q.iid
  ),
  judged as (
    select q.*,
           (case when po.n_ref > 0 then (q.k = 'reversal' and q.ref_any and po.n_ref = 1) else po.n_all = 1 end)
           and (case when pi.n_ref > 0 then (q.k = 'reversal' and q.ref_any and pi.n_ref = 1) else pi.n_all = 1 end) as only_one,
           (case when po.n_ref > 0 then (q.k = 'reversal' and q.ref_any) else true end)
           and (case when pi.n_ref > 0 then (q.k = 'reversal' and q.ref_any) else true end) as in_play,
           greatest(po.n_all, pi.n_all) as n_max
      from q
      join per_out po on po.oid = q.oid
      join per_in pi on pi.iid = q.iid
     where q.qualifies
  ),
  pairs as (
    select j.k,
           case when not j.only_one then 'ambiguous'
                when v_lock is not null and least(j.od, j.idt) <= v_lock then 'locked'
                when j.word_only then 'check'
                else 'sure' end as st,
           case when not j.only_one then
                  format('%s lines could pair here — nothing is booked when there is more than one match. Pair it by hand on the line.', j.n_max)
                when v_lock is not null and least(j.od, j.idt) <= v_lock then
                  format('Books are locked up to %s.', to_char(v_lock, 'DD Mon YYYY'))
                when j.word_only then
                  'A reversal word, but the two lines share no reference number or payee name — it may be a different refund. Check it and pair it by hand on the line.'
                when j.k = 'transfer' then
                  case when j.ref_strong then 'Same bank reference on both lines'
                       when j.tw_both then 'Own-transfer word on both lines'
                       else 'FD / card / OD word and the other line is in that FD / card / OD account' end
                  || format(', same amount, %s day(s) apart, the only open line on each side.', abs(j.idt - j.od))
                else
                  case when j.ref_strong then 'Same bank reference on both lines'
                       when j.ref_any then 'Reversal word on the money coming back, same cheque / reference number'
                       when j.shared_ref then 'Reversal word on the money coming back, same reference number in both narrations'
                       else 'Reversal word on the money coming back, same payee name' end
                  || format(', same amount, same account, %s day(s) apart, the only open line on each side.', abs(j.idt - j.od))
           end as why,
           j.amt, j.oid, j.oacc, j.oname, j.od, j.odesc, j.iid, j.iacc, j.iname, j.idt, j.idesc
      from judged j
     where j.in_play
  ),
  booked_side as (
    /* An open line with a reversal word whose same-amount opposite line (same account, ≤3 days) is
       already reconciled — and it has no open partner at all. Listed, never booked (A5). */
    select 'reversal'::text as k, 'other_side_booked'::text as st,
           format('The other line (%s) is already reconciled as %s — a data repair for the owner, not booked here.',
                  to_char(b.txn_date, 'DD Mon YYYY'), replace(b.matched_to_type, '_', ' ')) as why,
           greatest(l.dr, l.cr) as amt,
           case when l.dr > 0 then l.id else b.id end as oid,
           l.bank_account_id as oacc, l.acc_name as oname,
           case when l.dr > 0 then l.txn_date else b.txn_date end as od,
           case when l.dr > 0 then l.description else b.description end as odesc,
           case when l.dr > 0 then b.id else l.id end as iid,
           l.bank_account_id as iacc, l.acc_name as iname,
           case when l.dr > 0 then b.txn_date else l.txn_date end as idt,
           case when l.dr > 0 then b.description else l.description end as idesc
      from lines l
      join lateral (
        select x.id, x.txn_date, x.description, x.matched_to_type
          from lines x
         where x.bank_account_id = l.bank_account_id and x.id <> l.id
           and x.matched_to_type is not null
           and x.txn_date between l.txn_date - 3 and l.txn_date
           and (case when l.dr > 0 then x.cr = l.dr else x.dr = l.cr end)
         order by l.txn_date - x.txn_date, x.id
         limit 1
      ) b on true
     where l.matched_to_type is null
       and public.bank_pair_reversal_word(l.description)
       and not exists (select 1 from raw r where r.oid = l.id or r.iid = l.id)
  )
  select p.k, p.st, p.why, p.amt::integer,
         p.oid, p.oacc, p.oname, p.od, p.odesc, p.iid, p.iacc, p.iname, p.idt, p.idesc
    from (select * from pairs union all select * from booked_side) p
   where p_account_id is null or p.oacc = p_account_id or p.iacc = p_account_id
   order by case p.st when 'sure' then 0 when 'check' then 1 when 'ambiguous' then 2 when 'other_side_booked' then 3 else 4 end,
            p.od, p.oid, p.iid;
end;
$function$;
revoke all on function public.bank_pair_candidates(uuid) from public, anon;
grant execute on function public.bank_pair_candidates(uuid) to authenticated, service_role;

create or replace function public.book_bank_pairs(p_pairs jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant  uuid := public._r2656_pair_gate();
  v_run     uuid;
  v_p       record;
  v_cands   jsonb;
  v_c       jsonb;
  v_res     jsonb;
  v_n       integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_seen    uuid[] := '{}';
  v_out     public.bank_transactions;
  v_in      public.bank_transactions;
begin
  if p_pairs is null or jsonb_typeof(p_pairs) <> 'array' then
    raise exception 'Send the pairs to book as a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_pairs) > 500 then
    raise exception 'Book at most 500 pairs at a time.' using errcode = '22023';
  end if;

  /* The server decides, once per call: every pair it finds right now, keyed "out:in". */
  select coalesce(jsonb_object_agg(c.out_txn_id::text || ':' || c.in_txn_id::text,
                                   jsonb_build_object('kind', c.kind, 'status', c.status, 'reason', c.reason, 'amount', c.amount)), '{}'::jsonb)
    into v_cands
    from public.bank_pair_candidates(null) c;

  /* The run row first, outside every pair's savepoint (a failed pair must not take it with it). */
  insert into public.bank_pair_runs (tenant_id, created_by) values (v_tenant, public.current_user_id())
  returning id into v_run;

  for v_p in
    select (e->>'out_txn_id')::uuid as oid, (e->>'in_txn_id')::uuid as iid
      from jsonb_array_elements(p_pairs) e
  loop
    v_c := v_cands -> (v_p.oid::text || ':' || v_p.iid::text);
    if v_c is null or v_c->>'status' <> 'sure' then
      v_skipped := v_skipped || jsonb_build_object('out_txn_id', v_p.oid, 'in_txn_id', v_p.iid,
        'reason', coalesce(v_c->>'reason', 'Not a sure pair any more (a line was reconciled or changed since the preview).'));
      continue;
    end if;
    /* A sure pair's lines have no other partner, so this only catches the same pair sent twice. */
    if v_p.oid = any (v_seen) or v_p.iid = any (v_seen) then
      v_skipped := v_skipped || jsonb_build_object('out_txn_id', v_p.oid, 'in_txn_id', v_p.iid,
        'reason', 'Listed twice — booked once.');
      continue;
    end if;
    v_seen := v_seen || v_p.oid || v_p.iid;

    begin
      /* Lock both lines in id order; re-check they are still open. */
      perform 1 from public.bank_transactions where id = least(v_p.oid, v_p.iid) and tenant_id = v_tenant for update;
      perform 1 from public.bank_transactions where id = greatest(v_p.oid, v_p.iid) and tenant_id = v_tenant for update;
      select * into v_out from public.bank_transactions where id = v_p.oid and tenant_id = v_tenant;
      select * into v_in  from public.bank_transactions where id = v_p.iid and tenant_id = v_tenant;
      if v_out.matched_to_type is not null or v_in.matched_to_type is not null then
        raise exception 'Not a sure pair any more — a line of it was reconciled meanwhile.' using errcode = 'check_violation';
      end if;

      if v_c->>'kind' = 'transfer' then
        v_res := public.reconcile_bank_txn_as_transfer(v_p.oid, v_in.bank_account_id);
        if coalesce((v_res->>'added')::boolean, false) or (v_res->>'pair_id')::uuid is distinct from v_p.iid then
          raise exception 'The transfer would match a different line — not booked.' using errcode = 'check_violation';
        end if;
      else
        perform public.reconcile_bank_txn_manual(v_p.oid, 'Reversal pair (Find pairs): ' || (v_c->>'reason'), v_p.iid);
      end if;

      /* Both lines are open, so any live run pair still naming them is stale (un-reconciled by hand
         after that run) — release it, or the one-live-pair index would block this booking for ever. */
      update public.bank_pair_run_lines l set undone_at = now()
       where l.tenant_id = v_tenant and l.undone_at is null
         and (l.out_txn_id in (v_p.oid, v_p.iid) or l.in_txn_id in (v_p.oid, v_p.iid));

      insert into public.bank_pair_run_lines (run_id, tenant_id, kind, out_txn_id, in_txn_id, amount, out_matched_at, in_matched_at)
      select v_run, v_tenant, v_c->>'kind', v_p.oid, v_p.iid, (v_c->>'amount')::integer,
             (select t.matched_at from public.bank_transactions t where t.id = v_p.oid),
             (select t.matched_at from public.bank_transactions t where t.id = v_p.iid);
      v_n := v_n + 1;
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('out_txn_id', v_p.oid, 'in_txn_id', v_p.iid, 'reason', sqlerrm);
    end;
  end loop;

  if v_n = 0 then
    delete from public.bank_pair_runs where id = v_run;
    v_run := null;
  end if;
  return jsonb_build_object('run_id', v_run, 'booked', v_n, 'skipped', v_skipped);
end;
$function$;
revoke all on function public.book_bank_pairs(jsonb) from public, anon;
grant execute on function public.book_bank_pairs(jsonb) to authenticated, service_role;

create or replace function public.undo_bank_pair_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public._r2656_pair_gate();
  v_run    public.bank_pair_runs;
  v_l      record;
  v_n      integer := 0;
  v_left   jsonb := '[]'::jsonb;
  v_still  boolean;
begin
  select * into v_run from public.bank_pair_runs r where r.id = p_run_id and r.tenant_id = v_tenant for update;
  if not found then
    raise exception 'This pairs run is not in your company — reload the page.' using errcode = 'no_data_found';
  end if;

  for v_l in
    select l.id, l.kind, l.out_txn_id, l.in_txn_id, l.amount, l.out_matched_at, l.in_matched_at,
           o.txn_date as out_date, o.matched_to_type as o_type, o.matched_to_id as o_id, o.reversal_of as o_rev, o.matched_at as o_at,
           i.matched_to_type as i_type, i.matched_to_id as i_id, i.reversal_of as i_rev, i.matched_at as i_at
      from public.bank_pair_run_lines l
      join public.bank_transactions o on o.id = l.out_txn_id and o.tenant_id = v_tenant
      join public.bank_transactions i on i.id = l.in_txn_id and i.tenant_id = v_tenant
     where l.run_id = p_run_id and l.undone_at is null
     order by o.txn_date, l.out_txn_id
     for update of l, o, i
  loop
    /* Exactly the run's booking: the same type, each line naming the other, and the same matched_at
       (a hand re-booking of the same two lines later is NOT the run's, and is left alone). */
    v_still := v_l.o_at is not distinct from v_l.out_matched_at and v_l.i_at is not distinct from v_l.in_matched_at
               and case when v_l.kind = 'transfer' then
                      v_l.o_type = 'transfer' and v_l.o_id = v_l.in_txn_id::text
                      and v_l.i_type = 'transfer' and v_l.i_id = v_l.out_txn_id::text
                    else
                      v_l.o_type = 'manual' and v_l.o_rev = v_l.in_txn_id
                      and v_l.i_type = 'manual' and v_l.i_rev = v_l.out_txn_id
                    end;
    if not coalesce(v_still, false) then
      /* Not the run's any more: released from the run, listed. */
      update public.bank_pair_run_lines set undone_at = now() where id = v_l.id;
      v_left := v_left || jsonb_build_object('out_txn_id', v_l.out_txn_id, 'in_txn_id', v_l.in_txn_id,
        'txn_date', v_l.out_date, 'amount', v_l.amount,
        'reason', 'Changed since the run (un-reconciled or matched again by hand) — left as it is.');
      continue;
    end if;
    begin
      perform public.unreconcile_bank_receipt(v_l.out_txn_id, false);
      if exists (select 1 from public.bank_transactions t
                  where t.id in (v_l.out_txn_id, v_l.in_txn_id) and t.matched_to_type is not null) then
        raise exception 'One side stayed reconciled — left as it is.' using errcode = 'check_violation';
      end if;
      update public.bank_pair_run_lines set undone_at = now() where id = v_l.id;
      v_n := v_n + 1;
    exception when others then
      v_left := v_left || jsonb_build_object('out_txn_id', v_l.out_txn_id, 'in_txn_id', v_l.in_txn_id,
        'txn_date', v_l.out_date, 'amount', v_l.amount, 'reason', sqlerrm);
    end;
  end loop;

  if v_run.undone_at is null
     and not exists (select 1 from public.bank_pair_run_lines l where l.run_id = p_run_id and l.undone_at is null) then
    update public.bank_pair_runs set undone_at = now(), undone_by = public.current_user_id() where id = p_run_id;
  end if;
  return jsonb_build_object('run_id', p_run_id, 'undone', v_n, 'left', v_left);
end;
$function$;
revoke all on function public.undo_bank_pair_run(uuid) from public, anon;
grant execute on function public.undo_bank_pair_run(uuid) to authenticated, service_role;

commit;
