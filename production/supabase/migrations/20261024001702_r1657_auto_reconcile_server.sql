-- deploy-peek: to_regprocedure('public.auto_reconcile_bank_account(uuid,uuid,integer)') is not null
-- deploy-key: r1657autoreconcile
-- 20261024001702_r1657_auto_reconcile_server.sql
--
-- R-1657 (weekly UX audit, 19 Oct 2026) — bank auto-reconcile ran in the BROWSER: for every
-- unmatched line, one call to suggest_bank_transaction_matches and one to reconcile_bank_txn
-- (bank.ts useAutoReconcile). A thousand lines = two thousand round trips, and closing the tab
-- half-way left the job half done with no summary.
--
-- ══ WHAT THIS DOES ═══════════════════════════════════════════════════════════════════════
--   auto_reconcile_bank_account(p_account_id, p_after, p_limit) runs the SAME loop on the
--   server, one chunk (default 500 lines) per call, and returns a summary:
--     { checked, reconciled, review, no_match, low_confidence, ambiguous, failed, last_id, done }
--   The browser calls it once for an account of up to 500 unmatched lines, and once per 500
--   beyond that (passing last_id back as p_after), showing progress between chunks.
--
-- ══ THE MATCH RULE IS NOT CHANGED ════════════════════════════════════════════════════════
--   Exactly the browser's rule, line for line: take suggest_bank_transaction_matches in the
--   order it returns them (WITH ORDINALITY); apply the top one only when its confidence is
--   'exact' or 'high' AND no second suggestion shares that confidence; apply it through
--   reconcile_bank_txn(…, 'high') — the one atomic write (CLAUDE.md §17b) the manual dialog
--   uses too. Anything else is left for manual review.
--
-- ══ SAFE TO STOP, SAFE TO RE-RUN ═════════════════════════════════════════════════════════
--   Each line's reconcile runs in its own sub-transaction (BEGIN … EXCEPTION), so one bad line
--   (e.g. a prepaid advance already used) is counted as `failed` and the rest go on — as the
--   browser's try/catch did. A chunk is one statement: if the request dies, that chunk rolls
--   back whole, and the lines matched by earlier chunks stay matched. Only lines with
--   matched_to_id IS NULL are read, so running it again never touches a matched line.
--
-- ══ WHO MAY RUN IT ═══════════════════════════════════════════════════════════════════════
--   SECURITY INVOKER: RLS on bank_accounts / bank_transactions applies, and the two functions
--   it calls keep their own tenant + role gates. Up front it refuses a login with no company,
--   a role that may not match bank lines (same list as reconcile_bank_txn: owner, manager,
--   accountant, billing), and an account that is not the caller's company's — so a refused
--   caller gets one clear error instead of N "failed" lines. Granted to authenticated (R-401).

begin;

create or replace function public.auto_reconcile_bank_account(
  p_account_id uuid,
  p_after uuid default null,
  p_limit integer default 500
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_trusted   boolean;
  v_tenant    uuid := public.current_tenant_id();
  v_limit     integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
  v_txn       record;
  v_top       record;
  v_second    record;
  v_n         integer;
  v_checked   integer := 0;
  v_reconciled integer := 0;
  v_no_match  integer := 0;
  v_low       integer := 0;
  v_ambiguous integer := 0;
  v_failed    integer := 0;
  v_last      uuid := p_after;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
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
    select bt.id
      from public.bank_transactions bt
     where bt.bank_account_id = p_account_id
       and bt.matched_to_id is null
       and (p_after is null or bt.id > p_after)
     order by bt.id
     limit v_limit
  loop
    v_checked := v_checked + 1;
    v_last := v_txn.id;

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
$$;

comment on function public.auto_reconcile_bank_account(uuid, uuid, integer) is
  'R-1657: server-side bank auto-reconcile, one chunk per call; same match rule as the old browser loop; resumable via p_after.';

revoke execute on function public.auto_reconcile_bank_account(uuid, uuid, integer) from public;
revoke execute on function public.auto_reconcile_bank_account(uuid, uuid, integer) from anon;
grant execute on function public.auto_reconcile_bank_account(uuid, uuid, integer) to authenticated, service_role;

commit;
