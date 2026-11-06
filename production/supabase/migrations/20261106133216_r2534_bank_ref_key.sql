-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bank_transactions' and column_name = 'ref_key') and exists(select 1 from pg_trigger where tgname = 'trg_bank_txn_ref_key') and exists(select 1 from pg_proc where oid = to_regprocedure('public.suggest_bank_transaction_matches(uuid)') and prosrc like '%R-2534%')
-- deploy-key: r2534bankrefkey
--
-- R-2534 (6 Nov 2026, p1 money, G-RECON — RECON-SPEED research item 1). Nothing read the bank's own
-- reference (UTR / RRN / cheque number) out of a narration, so two same-day, same-amount credits were
-- always "ambiguous" and a receipt carrying the line's UTR ranked no higher than any other receipt of
-- that amount.
--
-- ─── WHAT THIS CHANGES ────────────────────────────────────────────────────────
--   bank_ref_norm(text)           — upper case, letters/digits only, leading zeros dropped (Tally's rule).
--   normalize_bank_ref(text,text) — the SQL twin of src/lib/banking/narration-ref.ts parseNarrationRef:
--                                   rail by keyword (UPI/IMPS/MMT → 12-digit RRN; NEFT/RTGS → 12–22 char
--                                   UTR with a letter, else an all-digit 16/22; CHQ/CHEQUE/CLG/CLEARING/
--                                   MICR → 6-digit cheque no.), else the Ref column in the rail's shape;
--                                   no rail → NULL. Same table tested on both (narration-ref-cases.ts).
--   bank_ref_matches(text,text)   — a receipt reference carries the key: equal, or (key ≥ 10 chars)
--                                   contained — the twin of referenceMatchesKey.
--   bank_transactions.ref_key     — new nullable column + partial index (tenant_id, ref_key).
--   trg_bank_txn_ref_key          — BEFORE INSERT / UPDATE OF description, reference: fills ref_key on
--                                   every write path (statement import, manual line, expense line).
--   Backfill                      — every existing line, row by row from its OWN description/reference
--                                   (no row reads another row, so no cross-company effect); only rows
--                                   whose key differs are written → a second run writes 0.
--   suggest_bank_transaction_matches(uuid) ← 20261104060346_r2364_suggestions_skip_used (latest; checked
--     all anutech/* branches): a receipt (payments) or project receipt whose reference carries the
--     line's ref_key AND whose cash part equals the line is 'exact' and ranks first — even for another
--     customer than the known payer, and up to 60 days apart (the window stays 7 days without a
--     reference). When such a receipt exists, the other same-amount candidates of that block are at
--     most 'high', so auto_reconcile_bank_account's "one sure candidate" rule books the referenced
--     one; two receipts carrying the same reference are both 'exact' → still ambiguous (fail closed).
--     All R-2364 "already used" filters unchanged.
-- Read-only metadata: no amount, match or books row changes.
-- Test: supabase/tests/r2534_bank_ref_key.test.sql (begin … rollback; red without this file).
begin;

create or replace function public.bank_ref_norm(p text)
returns text
language sql
immutable
parallel safe
set search_path to ''
as $$
  select ltrim(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g'), '0')
$$;

create or replace function public.normalize_bank_ref(p_description text, p_reference text default null)
returns text
language plpgsql
immutable
parallel safe
set search_path to ''
as $function$
declare
  d    text := upper(coalesce(p_description, ''));
  kind text;
  f    text;
  n    text;
begin
  /* R-2534: twin of narration-ref.ts — keep the steps in the same order. */
  if d ~ '(^|[^A-Z])(UPI|IMPS|MMT)([^A-Z]|$)' then kind := 'rrn';
  elsif d ~ '(^|[^A-Z])(NEFT|RTGS)([^A-Z]|$)' then kind := 'utr';
  elsif d ~ '(^|[^A-Z])(CHQ|CHEQUE|CLG|CLEARING|MICR)([^A-Z]|$)' then kind := 'cheque';
  else return null;
  end if;

  if kind = 'rrn' then
    f := (regexp_match(d, '(^|[^0-9])([0-9]{12})([^0-9@]|$)'))[2];
  elsif kind = 'utr' then
    select x.t into f
      from regexp_split_to_table(d, '[^A-Z0-9]+') with ordinality as x(t, i)
     where length(x.t) between 12 and 22
       and length(regexp_replace(x.t, '[^0-9]', '', 'g')) >= 6
       and x.t ~ '[A-Z]'
     order by x.i limit 1;
    if f is null then
      select x.t into f
        from regexp_split_to_table(d, '[^A-Z0-9]+') with ordinality as x(t, i)
       where x.t ~ '^[0-9]+$' and length(x.t) in (16, 22)
       order by x.i limit 1;
    end if;
  else
    f := (regexp_match(d, '(^|[^0-9])([0-9]{6})([^0-9]|$)'))[2];
  end if;

  f := nullif(public.bank_ref_norm(f), '');
  if f is not null then
    return f;
  end if;

  n := public.bank_ref_norm(p_reference);
  if n = '' then
    return null;
  end if;
  if kind = 'rrn' then
    return case when n ~ '^[0-9]{12}$' then n end;
  elsif kind = 'utr' then
    return case when length(n) between 12 and 22 and length(regexp_replace(n, '[^0-9]', '', 'g')) >= 6 then n end;
  end if;
  return case when n ~ '^[0-9]{1,6}$' then n end;
end;
$function$;

create or replace function public.bank_ref_matches(p_reference text, p_key text)
returns boolean
language sql
immutable
parallel safe
set search_path to ''
as $$
  select k <> '' and r <> '' and (r = k or (length(k) >= 10 and strpos(r, k) > 0))
    from (select public.bank_ref_norm(p_key) as k, public.bank_ref_norm(p_reference) as r) x
$$;

comment on function public.normalize_bank_ref(text, text) is
  'R-2534: the bank''s own reference of a line (UTR / RRN / cheque no.) from its narration, else its Ref column; NULL when there is none. Twin of src/lib/banking/narration-ref.ts.';

revoke all on function public.bank_ref_norm(text) from public, anon;
revoke all on function public.normalize_bank_ref(text, text) from public, anon;
revoke all on function public.bank_ref_matches(text, text) from public, anon;
grant execute on function public.bank_ref_norm(text) to authenticated, service_role;
grant execute on function public.normalize_bank_ref(text, text) to authenticated, service_role;
grant execute on function public.bank_ref_matches(text, text) to authenticated, service_role;

alter table public.bank_transactions add column if not exists ref_key text;
comment on column public.bank_transactions.ref_key is
  'R-2534: UTR / RRN / cheque number read from the narration (normalize_bank_ref). Filled by trg_bank_txn_ref_key.';

create index if not exists bank_txn_tenant_ref_key_idx
  on public.bank_transactions (tenant_id, ref_key)
  where ref_key is not null;

create or replace function public.tg_bank_txn_ref_key()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  new.ref_key := public.normalize_bank_ref(new.description, new.reference);   -- R-2534
  return new;
end;
$function$;

drop trigger if exists trg_bank_txn_ref_key on public.bank_transactions;
create trigger trg_bank_txn_ref_key
  before insert or update of description, reference on public.bank_transactions
  for each row execute function public.tg_bank_txn_ref_key();

-- Backfill: each row from its own text only; rows already right are not written (idempotent).
update public.bank_transactions bt
   set ref_key = public.normalize_bank_ref(bt.description, bt.reference)
 where bt.ref_key is distinct from public.normalize_bank_ref(bt.description, bt.reference);

CREATE OR REPLACE FUNCTION public.suggest_bank_transaction_matches(p_bank_txn_id uuid)
 RETURNS TABLE(match_type text, match_id text, match_label text, match_amount integer, match_date date, match_confidence text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_txn record; v_tenant uuid; v_search_amount integer; v_is_credit boolean;
  v_caller uuid; v_trusted boolean; v_known uuid; v_payer_customers uuid[]; v_ref text;
begin
  /* R-715: a signed-in caller sees suggestions only for their own company's bank line.
     No company (null-caller) → refused; another company's line → nothing (as "not found"). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '42501';
  end if;
  select bt.* into v_txn from public.bank_transactions bt where bt.id = p_bank_txn_id;
  if not found then return; end if;
  if not v_trusted and v_txn.tenant_id is distinct from v_caller then return; end if;
  v_tenant := v_txn.tenant_id; v_search_amount := greatest(v_txn.debit, v_txn.credit); v_is_credit := v_txn.credit > 0;
  v_ref := nullif(v_txn.ref_key, '');   -- R-2534: the line's own UTR / RRN / cheque no.
  if v_is_credit then
    /* R-2364: who paid — the line's own payer answer (R-2025), else exactly one customer with a
       known payer whose key EQUALS one dash/slash part of the narration (the rails' name slots —
       "NEFT CR-<IFSC>-GIBI PAUL-<us>-<UTR>"; customer-payer.ts knownPayerCustomer's equality,
       never a loose word hit). Two customers → no guess. */
    if coalesce(v_txn.payer->>'customer_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select c.id into v_known from public.customers c
       where c.id = (v_txn.payer->>'customer_id')::uuid and c.tenant_id = v_tenant;
    end if;
    if v_known is null then
      select array_agg(distinct cp.customer_id) into v_payer_customers
        from public.customer_payers cp
       where cp.tenant_id = v_tenant
         and cp.payer_name_key in (select public.payer_name_key(part)
                                     from regexp_split_to_table(coalesce(v_txn.description, ''), '[-/]') part);
      if cardinality(v_payer_customers) = 1 then v_known := v_payer_customers[1]; end if;
    end if;

    return query
    with cand as (
      select p.id, p.customer_id, p.received_at::date as d, (p.amount - p.credit_applied) as cash,
             coalesce(c.name, p.receipt_voucher_no, 'Payment') || case when p.reference is not null and p.reference <> '' then ' · ' || p.reference else '' end as label,
             -- R-2534: the receipt carries this line's own bank reference.
             (v_ref is not null and public.bank_ref_matches(p.reference, v_ref)) as by_ref
        from public.payments p left join public.customers c on c.id = p.customer_id
       -- R-1565: the bank saw only the cash part; a payment paid wholly by advance credit is never suggested.
       where p.tenant_id = v_tenant and p.status = 'received' and (p.amount - p.credit_applied) > 0
         and abs((p.amount - p.credit_applied) - v_search_amount) <= 100
         -- R-2534: 7 days by amount; up to 60 days when the reference is the line's own.
         and (abs(p.received_at::date - v_txn.txn_date) <= 7
              or (v_ref is not null and abs(p.received_at::date - v_txn.txn_date) <= 60
                  and public.bank_ref_matches(p.reference, v_ref)))
         -- R-2364: never a receipt another bank line already carries …
         and not exists (select 1 from public.bank_transactions t
                          where t.tenant_id = v_tenant and t.id <> v_txn.id
                            and t.matched_to_type = 'payment' and t.matched_to_id = p.id::text)
         -- … nor one a reconciled split line holds (R-2098) …
         and not (p.bank_txn_id is not null and p.bank_txn_id <> v_txn.id
                  and exists (select 1 from public.bank_transactions t2
                               where t2.id = p.bank_txn_id and t2.tenant_id = v_tenant and t2.matched_to_type is not null))
         -- … nor one created from another line (BANK-<line id>) while that line is reconciled (un-reconciled
         -- → the receipt is free again, e.g. a duplicate import kept as undeposited).
         and not (coalesce(p.reference, '') ~* '^BANK-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  and lower(substr(p.reference, 6)) <> v_txn.id::text
                  and exists (select 1 from public.bank_transactions t3
                               where t3.id = lower(substr(p.reference, 6))::uuid and t3.tenant_id = v_tenant
                                 and t3.matched_to_type is not null))
    ), ranked as (
      select cand.*, (cand.by_ref and cand.cash = v_search_amount) as ref_exact,
             bool_or(cand.by_ref and cand.cash = v_search_amount) over () as any_ref_exact
        from cand
    )
    select 'payment'::text, r.id::text, r.label, r.cash, r.d,
           case when r.ref_exact then 'exact'
                when v_known is not null and r.customer_id is distinct from v_known then 'low'
                when abs(r.d - v_txn.txn_date) > 7 then 'low'
                -- R-2534: another receipt carries the line's reference → this one is at most 'high'.
                when r.cash = v_search_amount and r.d = v_txn.txn_date and not r.any_ref_exact then 'exact'
                when r.cash = v_search_amount and abs(r.d - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
      from ranked r
    order by r.ref_exact desc, r.by_ref desc, coalesce(r.customer_id = v_known, false) desc,
             abs(r.cash - v_search_amount), abs(r.d - v_txn.txn_date) limit 5;

    return query
    with cand as (
      select pp.id, pp.amount, pp.received_at::date as d,
             coalesce(ps.customer_name, ps.title, 'Project payment') || ' · project' as label,
             (v_ref is not null and public.bank_ref_matches(pp.reference, v_ref)) as by_ref
        from public.project_payments pp
        join public.project_sales ps on ps.id = pp.project_id
       where pp.tenant_id = v_tenant and pp.bank_txn_id is null
         and abs(pp.amount - v_search_amount) <= 100
         and (abs(pp.received_at::date - v_txn.txn_date) <= 7
              or (v_ref is not null and abs(pp.received_at::date - v_txn.txn_date) <= 60
                  and public.bank_ref_matches(pp.reference, v_ref)))
    ), ranked as (
      select cand.*, (cand.by_ref and cand.amount = v_search_amount) as ref_exact,
             bool_or(cand.by_ref and cand.amount = v_search_amount) over () as any_ref_exact
        from cand
    )
    select 'project'::text, r.id::text, r.label, r.amount, r.d,
           case when r.ref_exact then 'exact'
                when abs(r.d - v_txn.txn_date) > 7 then 'low'
                when r.amount = v_search_amount and r.d = v_txn.txn_date and not r.any_ref_exact then 'exact'
                when r.amount = v_search_amount and abs(r.d - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
      from ranked r
    order by r.ref_exact desc, r.by_ref desc, abs(r.amount - v_search_amount), abs(r.d - v_txn.txn_date) limit 5;
  end if;
  if not v_is_credit then
    return query
    select 'salary'::text, sp.id::text, e.name || ' · salary ' || sp.period, sp.net, sp.pay_date,
           case when sp.net = v_search_amount and sp.pay_date = v_txn.txn_date then 'exact'
                when sp.net = v_search_amount and abs(sp.pay_date - v_txn.txn_date) <= 10 then 'high' else 'low' end::text
    from public.salary_payments sp join public.employees e on e.id = sp.employee_id
    where sp.tenant_id = v_tenant and sp.paid_status = 'unpaid' and abs(sp.net - v_search_amount) <= 100 and abs(sp.pay_date - v_txn.txn_date) <= 15
    order by abs(sp.net - v_search_amount), abs(sp.pay_date - v_txn.txn_date) limit 5;
    return query
    select 'expense'::text, e.id::text, coalesce(e.vendor_name, e.category, 'Expense'), e.amount, e.expense_date,
           case when e.amount = v_search_amount and e.expense_date = v_txn.txn_date then 'exact'
                when e.amount = v_search_amount and abs(e.expense_date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.expenses e
    where e.tenant_id = v_tenant and e.category <> 'Salaries' and abs(e.amount - v_search_amount) <= 100 and abs(e.expense_date - v_txn.txn_date) <= 7
      -- R-2364: never an expense already reconciled to another bank line (R-2325's browser rule).
      and (e.reconciled_txn_id is null or e.reconciled_txn_id = v_txn.id)
      and not exists (select 1 from public.bank_transactions t
                       where t.tenant_id = v_tenant and t.id <> v_txn.id
                         and t.matched_to_type = 'expense' and t.matched_to_id = e.id)
    order by abs(e.amount - v_search_amount), abs(e.expense_date - v_txn.txn_date) limit 5;
  end if;
end; $function$;
revoke all on function public.suggest_bank_transaction_matches(uuid) from public, anon;
grant execute on function public.suggest_bank_transaction_matches(uuid) to authenticated, service_role;

commit;
