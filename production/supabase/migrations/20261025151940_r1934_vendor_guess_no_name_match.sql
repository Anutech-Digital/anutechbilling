-- deploy-peek: exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'bank_debit_vendor_guess' and p.prosrc like '%R-1934%')
-- deploy-key: r1934vendorguess
-- R-1934 (25 Oct 2026): bank_debit_vendor_guess crashed on any money-out line whose narration
-- shares no word with any vendor name: "record "v_top" is not assigned yet".
-- Cause (R-1867, 20261024211000 line 92): after the name-word loop found 0 vendors, the final
--   if v_n = 1 or (v_n = 2 and v_top.shared > v_next.shared)
-- still reads v_top.shared — PL/pgSQL binds every record field of the expression before SQL
-- evaluates it, so AND does not short-circuit the unassigned record. auto_reconcile_bank_account
-- (R-1657) calls this through bank_debit_vendor_auto_match for every unmatched money-out line,
-- so one such line (a bank fee, "Rent") stopped the whole "Auto-reconcile" run. CI's
-- r1657_auto_reconcile test showed it.
-- Fix: return early when no vendor shares a word; compare v_top / v_next only when two rows exist.
-- Body otherwise unchanged from its latest definition (R-1867; R-1911 only calls it).

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
  -- R-1934: v_top is unassigned when no vendor shares a word — never read it then.
  if v_n = 0 then
    return null;
  end if;
  if v_n = 1 or v_top.shared > v_next.shared then
    return v_top.id;
  end if;
  return null;
end;
$$;

revoke all on function public.bank_debit_vendor_guess(uuid) from public, anon;
grant execute on function public.bank_debit_vendor_guess(uuid) to authenticated, service_role;
