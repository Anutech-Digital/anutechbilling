-- deploy-peek: to_regprocedure('public.bank_debit_vendor_guess(uuid)') is not null and to_regprocedure('public.bank_debit_vendor_auto_match(uuid)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.auto_reconcile_bank_account(uuid,uuid,integer)') and prosrc like '%R-1867%')
-- deploy-key: r1867autovendorpayment
-- 20261024211000_r1867_auto_vendor_payment.sql
--
-- R-1867 (24 Oct 2026, Pardeep — split from R-1866): Auto-reconcile should settle a vendor payment
-- when there is exactly one open bill of the same amount and the vendor is named in the narration.
--
-- ─── WHAT WAS THERE ─────────────────────────────────────────────────────────
--   auto_reconcile_bank_account (R-1864) knew EMIs and then fell back to
--   suggest_bank_transaction_matches → reconcile_bank_txn. For a money-out line that meant an
--   unpaid expense bill of the same amount was only "matched" (one document, no TDS, not via the
--   R-1866 vendor-payment records), and a COGS bill (vendor_bills) was never offered at all.
--
-- ─── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--   bank_debit_vendor_guess(txn)      — the payee, the SAME rule as the app's guessVendor
--                                       (src/lib/banking/debit-pay-for.ts) that pre-fills the
--                                       Reconcile sheet and drives the "Money out · no vendor yet"
--                                       filter (R-1869): UPI id, else account number, else the
--                                       vendor sharing the MOST distinctive name words — only when
--                                       no other vendor shares as many. Same noise-word lists as
--                                       src/lib/accounting/credit-match.ts.
--   bank_debit_vendor_auto_match(txn) — that vendor's open bills (R-1866 bank_debit_vendor_open_items)
--                                       whose CASH due equals the debit: a COGS bill at its amount
--                                       due; an expense bill at amount − the TDS already on it (no
--                                       new TDS is guessed). Bill dated on/before the bank line, not
--                                       in an open payment run.
--   auto_reconcile_bank_account       — after the EMI step: exactly ONE such bill → paid through
--                                       reconcile_bank_debit_to_vendor (R-1866), never
--                                       reconcile_bank_txn. Two or more → left for review
--                                       (ambiguous). None → the old suggestion path, unchanged.
--   suggest_bank_transaction_matches is NOT changed: the Reconcile sheet's "This payment is for:"
--   section (R-1866) already pre-selects the exact bill, and the suggestion list has no
--   vendor-payment action to run.
--
-- Guards: §17c fail-closed tenant check, R-718 money roles (owner / manager / accountant / billing).
-- Stored data is not changed by the migration itself.
-- Test: supabase/tests/r1867_auto_vendor_payment.test.sql

begin;

-- ── 1. Who was paid — the app's guessVendor, in SQL ─────────────────────────
create or replace function public.bank_debit_vendor_guess(p_txn_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_txn     public.bank_transactions;
  v_text    text;
  v_id      uuid;
  v_n       integer;
  v_top     record;
  v_next    record;
  -- credit-match.ts NARRATION_NOISE / NAME_NOISE — keep in step.
  c_narr_noise constant text[] := array[
    'upi','imps','neft','rtgs','tpt','ift','ach','ecs','emi','chq','cheque',
    'cr','dr','ref','txn','api','banking','transfer','payment','paid','from',
    'hdfc','icic','icici','sbin','sbi','axis','axl','barb','pnb','kkbk','utib',
    'yesb','idib','cnrb','ubin','iob','bkid','mahb','nesf','okhdfcbank','oksbi',
    'okaxis','okicici','ybl','paytm','ptm','ptyes','gpay','phonepe','apl','airtel',
    'collect','reversal','refund','charges','interest','given','loan','self'];
  c_name_noise constant text[] := array[
    'pvt','private','ltd','limited','llp','inc','co','company','corp',
    'corporation','corprotion','and','the','enterprises','enterprise','solutions',
    'technologies','technology','services','service','systems','digital'];
begin
  /* §17c fail-closed + money roles (the guess reads the vendor list). */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can match bank lines' using errcode = '42501';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id;
  if not found or (v_caller is not null and v_txn.tenant_id is distinct from v_caller) then
    return null;
  end if;
  v_text := coalesce(v_txn.description, '') || ' ' || coalesce(v_txn.reference, '');

  -- (a) UPI id in the narration — exactly one vendor.
  select count(*), min(v.id::text)::uuid into v_n, v_id
    from public.vendors v
   where v.tenant_id = v_txn.tenant_id
     and nullif(trim(coalesce(v.upi_id, '')), '') is not null
     and strpos(lower(v_text), lower(trim(v.upi_id))) > 0;
  if v_n = 1 then return v_id; end if;

  -- (b) Account number: a 6+ digit run in the narration that is the end of the vendor's number
  --     (masked statements show the tail) or ends with it.
  select count(*), min(v.id::text)::uuid into v_n, v_id
    from public.vendors v
   where v.tenant_id = v_txn.tenant_id
     and length(regexp_replace(coalesce(v.bank_account_no, ''), '[^0-9]', '', 'g')) >= 6
     and exists (
       select 1
         from regexp_split_to_table(regexp_replace(v_text, '[^0-9]', ' ', 'g'), '\s+') d
        where length(d) >= 6
          and (right(regexp_replace(v.bank_account_no, '[^0-9]', '', 'g'), length(d)) = d
               or right(d, length(regexp_replace(v.bank_account_no, '[^0-9]', '', 'g'))) = regexp_replace(v.bank_account_no, '[^0-9]', '', 'g')));
  if v_n = 1 then return v_id; end if;

  -- (c) Name words: the vendor sharing the most distinctive words, only when no one else shares as many.
  --     The narration side reads the description only (as guessVendor does).
  v_n := 0;
  for v_next in
    with words as (
      select distinct w
        from regexp_split_to_table(lower(coalesce(v_txn.description, '')), '[^a-z]+') w
       where length(w) >= 3 and w <> all (c_narr_noise) and w !~ '^x+$'
    )
    select v.id, count(distinct t) as shared
      from public.vendors v
      cross join lateral regexp_split_to_table(lower(coalesce(v.name, '')), '[^a-z]+') t
     where v.tenant_id = v_txn.tenant_id
       and length(t) >= 3 and t <> all (c_name_noise)
       and t in (select w from words)
     group by v.id
     order by 2 desc
     limit 2
  loop
    v_n := v_n + 1;
    if v_n = 1 then v_top := v_next; end if;
  end loop;
  if v_n = 1 or (v_n = 2 and v_top.shared > v_next.shared) then
    return v_top.id;
  end if;
  return null;
end;
$$;

revoke all on function public.bank_debit_vendor_guess(uuid) from public, anon;
grant execute on function public.bank_debit_vendor_guess(uuid) to authenticated, service_role;

-- ── 2. The bills a money-out line surely paid ───────────────────────────────
create or replace function public.bank_debit_vendor_auto_match(p_txn_id uuid)
returns table (
  vendor_id   uuid,
  source      text,      -- vendor_bill | expense
  doc_id      text,
  bill_no     text,
  amount      integer,   -- gross the bill is settled by (amount due)
  tds_amount  integer,   -- TDS already on the expense row (0 for a COGS bill)
  tds_section text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_txn     public.bank_transactions;
  v_vendor  uuid;
begin
  /* §17c fail-closed + R-718 money roles. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can match bank lines' using errcode = '42501';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id;
  if not found or (v_caller is not null and v_txn.tenant_id is distinct from v_caller) then return; end if;
  if coalesce(v_txn.debit, 0) <= 0 or v_txn.matched_to_type is not null then return; end if;

  v_vendor := public.bank_debit_vendor_guess(p_txn_id);
  if v_vendor is null then return; end if;

  return query
  select v_vendor, o.source, o.doc_id, o.bill_no, o.amount_due, coalesce(o.tds_amount, 0), o.tds_section
    from public.bank_debit_vendor_open_items(v_vendor) o
   where o.in_run is null
     and o.doc_date <= v_txn.txn_date
     and o.amount_due - coalesce(o.tds_amount, 0) = v_txn.debit
     and (coalesce(o.tds_amount, 0) = 0 or nullif(trim(coalesce(o.tds_section, '')), '') is not null)
   order by o.doc_date, o.doc_id;
end;
$$;

revoke all on function public.bank_debit_vendor_auto_match(uuid) from public, anon;
grant execute on function public.bank_debit_vendor_auto_match(uuid) to authenticated, service_role;

-- ── 3. Auto-reconcile: a vendor line with ONE sure bill is paid through R-1866 ──
--   R-1867: same as 20261024200500 (R-1864) plus the vendor step after the EMI step.
CREATE OR REPLACE FUNCTION public.auto_reconcile_bank_account(p_account_id uuid, p_after uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_trusted   boolean;
  v_tenant    uuid := public.current_tenant_id();
  v_limit     integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
  v_txn       record;
  v_top       record;
  v_second    record;
  v_emi       record;
  v_emi_n     integer;
  v_vp        record;
  v_vp_n      integer;
  v_n         integer;
  v_checked   integer := 0;
  v_reconciled integer := 0;
  v_no_match  integer := 0;
  v_low       integer := 0;
  v_ambiguous integer := 0;
  v_failed    integer := 0;
  v_last      uuid := p_after;
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted then
    if v_tenant is null then
      raise exception 'No company on this login' using errcode = '42501';
    end if;
    if not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
      raise exception 'Only an owner, manager, accountant or billing user can match bank lines' using errcode = '42501';
    end if;
    if not exists (select 1 from public.bank_accounts ba where ba.id = p_account_id and ba.tenant_id = v_tenant) then
      raise exception 'Bank account not found' using errcode = 'no_data_found';
    end if;
  end if;

  for v_txn in
    select bt.id, bt.debit
      from public.bank_transactions bt
     where bt.bank_account_id = p_account_id
       and bt.matched_to_id is null
       and (p_after is null or bt.id > p_after)
     order by bt.id
     limit v_limit
  loop
    v_checked := v_checked + 1;
    v_last := v_txn.id;

    -- R-1864: an EMI debit with exactly one sure, same-amount EMI candidate.
    if coalesce(v_txn.debit, 0) > 0 and v_tenant is not null
       and public.current_user_has_role('owner', 'manager', 'accountant') then
      v_emi_n := 0;
      for v_second in
        select m.purchase_id, m.seq, m.confidence
          from public.emi_matches_for_bank_txn(v_txn.id) m
         where m.difference = 0 and m.confidence in ('exact', 'high')
      loop
        v_emi_n := v_emi_n + 1;
        if v_emi_n = 1 then v_emi := v_second; end if;
      end loop;
      if v_emi_n = 1 then
        begin
          perform public.reconcile_bank_debit_to_emi(v_txn.id, v_emi.purchase_id, v_emi.seq);
          v_reconciled := v_reconciled + 1;
        exception when others then
          v_failed := v_failed + 1;
        end;
        continue;
      elsif v_emi_n > 1 then
        v_ambiguous := v_ambiguous + 1;
        continue;
      elsif exists (select 1 from public.emi_matches_for_bank_txn(v_txn.id)) then
        -- An EMI that is not exact (a late fee, a changed amount): the owner picks the split.
        v_low := v_low + 1;
        continue;
      end if;
    end if;

    -- R-1867: a vendor named in the narration with exactly ONE open bill whose cash due = the
    -- debit → paid through reconcile_bank_debit_to_vendor (R-1866). Two or more → review.
    if coalesce(v_txn.debit, 0) > 0 and v_tenant is not null
       and public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
      v_vp_n := 0;
      for v_second in select m.* from public.bank_debit_vendor_auto_match(v_txn.id) m loop
        v_vp_n := v_vp_n + 1;
        if v_vp_n = 1 then v_vp := v_second; end if;
      end loop;
      if v_vp_n = 1 then
        begin
          perform public.reconcile_bank_debit_to_vendor(
            v_txn.id, v_vp.vendor_id, null,
            jsonb_build_array(jsonb_build_object(
              'source', v_vp.source, 'doc_id', v_vp.doc_id, 'amount', v_vp.amount,
              'tds_amount', v_vp.tds_amount, 'tds_section', v_vp.tds_section)),
            null, 0, null, 0, 'Auto-reconcile (R-1867)');
          v_reconciled := v_reconciled + 1;
        exception when others then
          v_failed := v_failed + 1;
        end;
        continue;
      elsif v_vp_n > 1 then
        v_ambiguous := v_ambiguous + 1;
        continue;
      end if;
    end if;

    v_n := 0;
    for v_second in
      select s.match_type, s.match_id, s.match_confidence
        from public.suggest_bank_transaction_matches(v_txn.id) with ordinality as s(match_type, match_id, match_label, match_amount, match_date, match_confidence, ord)
       order by s.ord
       limit 2
    loop
      v_n := v_n + 1;
      if v_n = 1 then v_top := v_second; end if;
    end loop;

    if v_n = 0 then
      v_no_match := v_no_match + 1;
    elsif v_top.match_confidence not in ('exact', 'high') then
      v_low := v_low + 1;
    elsif v_n = 2 and v_second.match_confidence = v_top.match_confidence then
      v_ambiguous := v_ambiguous + 1;
    else
      begin
        perform public.reconcile_bank_txn(v_txn.id, v_top.match_type, v_top.match_id, 'high');
        v_reconciled := v_reconciled + 1;
      exception when others then
        v_failed := v_failed + 1;
      end;
    end if;
  end loop;

  return jsonb_build_object(
    'checked',        v_checked,
    'reconciled',     v_reconciled,
    'review',         v_no_match + v_low + v_ambiguous + v_failed,
    'no_match',       v_no_match,
    'low_confidence', v_low,
    'ambiguous',      v_ambiguous,
    'failed',         v_failed,
    'last_id',        v_last,
    'done',           v_checked < v_limit
  );
end;
$function$;

commit;
