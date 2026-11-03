-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quote_approval_not_by_maker()') and prosrc like '%R-2447%') and exists(select 1 from pg_trigger where tgname = 'trg_quote_insert_approval_guard' and tgrelid = to_regclass('public.quotes'))
-- deploy-key: r2447quoteapprovalinsertmoneychange
-- 20261103202530_r2447_quote_approval_insert_and_money_change
--
-- R-2447 (3 Nov 2026) — gaps R-2441 left on its card (review.left), plus F1 of the independent
-- money review 3 (Anutech-HQ/drafts/REVIEWS/2026-11-04-money-cards-3.md). The approval guard
-- trg_quote_approval_not_by_maker ran only on an UPDATE of approval_status / approved_by, so:
--   a. a quote could be INSERTED already approved (or rejected) — no role check at all;
--   b. on an approved quote, below_cost could turn true and the old (manager) approval kept
--      covering a below-cost quote — money is let through on approval_status alone (R-2213);
--   c. F1: on an approved quote a rep could, in one direct update, null or rewrite the signed numbers
--      (approved_discount_bps / approved_margin_bps), the tier or approved_at, and reprice the lines —
--      isStale() skips its check when the signed numbers are null, so the send gate let a 45%-off /
--      below-cost quote go out under the old approval.
--
-- ─── 1. INSERT (new trigger trg_quote_insert_approval_guard, SECURITY INVOKER) ───
--   A login's direct insert (PostgREST: authenticated / anon; the Cloud SQL gateway: app_runtime / app_anon) may not create a quote
--   that is already approved or rejected — the inserter is the maker, and a maker never clears their
--   own quote except the sole owner WITH a reason, which the app does through Review & decide after
--   saving; nothing in the app inserts an approved quote. A pending / not-required insert keeps no
--   signer, signing time or signed numbers. Allowed as before: a service / cron path (role
--   service_role) and SECURITY DEFINER functions — inside them current_user is the function owner,
--   which is how combine_quotes (R-1527) still copies its sources' approval onto the combined quote
--   (it checks its sources itself). That is why this guard is a separate INVOKER trigger: inside the
--   SECURITY DEFINER approval trigger current_user is always its owner and cannot tell them apart.
--
-- ─── 2. UPDATE of an approved quote (tg_quote_approval_not_by_maker, latest body R-2441) ───
--   The trigger now also fires on approved_at, approved_discount_bps, approved_margin_bps,
--   approval_tier, below_cost and line_items. When the quote was approved and stays approved under
--   the same signer:
--   • the signed numbers, the tier or approved_at change → it is a fresh signing: approved_by := the
--     login and the R-2367/R-2441 role checks run (a rep is refused; the signer may re-sign numbers
--     within their role) — F1 "refused unless the same update re-approves";
--   • otherwise, below_cost turns true, or a line edit makes the approval STALE → back to pending
--     (tier = what the NEW numbers need: owner when below cost, already owner, margin unknown / under
--     12% or discount over 20%, else manager), asked by the login (whoever moved the price is a maker), the old
--     verdict cleared, one activity_log line 'quote.approval_reset'.
--   "Stale" is isStale() of src/lib/quotes/approval.ts on the numbers lineEconomics() gives for the
--   NEW lines (public.quote_lines_approval_bps, same maths): discount deeper, margin thinner, margin
--   now unknown, or a number unknown when signed that now needs sign-off by itself (discount over 10%,
--   margin under 12%) — and only when the lines' numbers
--   actually moved. Why not "any line edit → pending" (decision recorded on the card): the existing
--   flow (approval.ts header, isStale) keeps an approval when the rep IMPROVES the deal, and the
--   bank-credit RPCs (R-1838/R-2044/R-2095/R-2098) write start/renewal dates into the lines of
--   approved quotes under a login — neither may knock the approval off.
--   • below_cost turning false by a login while the lines are still below cost (bank_sale_lines_below_cost,
--     R-2397 = linesBelowCost) is refused — the R-2213 money guard reads that mark; the owner approves,
--     or the price is raised first.
--   A service path with no login is unchanged (as since R-2367).
--
-- Test: supabase/tests/r2447_quote_approval_insert_and_money_change.test.sql
-- (+ r2441_review_fixes, r2426_sole_owner_any_tier, r2383_sole_owner_self_approval,
--  r2367_quote_chain_self_approval, r1527_combine_quotes).

begin;

-- A line's number as JS reads it for the maths: a JSON number, or a numeric string ("5" * 500 = 2500
-- in JS); anything else is null (missing).
create or replace function public.quote_line_num(p_val jsonb)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when jsonb_typeof(p_val) = 'number' then (p_val #>> '{}')::numeric
              when jsonb_typeof(p_val) = 'string' and btrim(p_val #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$'
                then btrim(p_val #>> '{}')::numeric end
$$;

revoke all on function public.quote_line_num(jsonb) from public, anon;
grant execute on function public.quote_line_num(jsonb) to authenticated, service_role;   -- pure parsing

-- lineEconomics() + discountBps() + marginBps() of src/lib/quotes/approval-economics.ts / approval.ts —
-- keep in step (supabase/tests/r2447_… pins the numbers). Math.round(x) = floor(x + 0.5). A missing
-- value reads as a missing one does in JS (rate/qty 0; list_rate → rate; cost unknown).
create or replace function public.quote_lines_approval_bps(p_lines jsonb, out discount_bps integer, out margin_bps integer)
language sql
immutable
parallel safe
set search_path = ''
as $$
  with l as (
    select coalesce(public.quote_line_num(li->'qty'), 0)  as q,
           coalesce(public.quote_line_num(li->'rate'), 0) as r,
           coalesce(public.quote_line_num(li->'list_rate'), public.quote_line_num(li->'rate'), 0) as lr,
           public.quote_line_num(li->'cost')              as c,
           coalesce(public.quote_line_num(li->'discount_pct'), 0) as dp,
           li->>'item_id'                                 as item_id
      from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) li
     where jsonb_typeof(li) = 'object'
  ), e as (
    select coalesce(sum(q * r - floor(q * r * dp / 100 + 0.5)), 0) as sub,
           coalesce(sum(q * lr), 0)                                as list,
           coalesce(sum(q * coalesce(c, 0)), 0)                     as cost,
           coalesce(bool_or(r > 0 and coalesce(item_id, '') not like 'SUP-%' and (c is null or c <= 0)), false) as unknown
      from l
  )
  select case when list <= 0 then null
              when list - sub <= 0 then 0
              else floor((list - sub) / list * 10000 + 0.5)::integer end,
         case when unknown or sub <= 0 then null
              else floor((sub - cost) / sub * 10000 + 0.5)::integer end
    from e
$$;

revoke all on function public.quote_lines_approval_bps(jsonb) from public, anon;
grant execute on function public.quote_lines_approval_bps(jsonb) to authenticated, service_role;   -- pure maths on the given lines

comment on function public.quote_lines_approval_bps(jsonb) is
  'R-2447: discount and gross margin (basis points) of a quote''s line_items — the same maths as lineEconomics/discountBps/marginBps in src/lib/quotes. Null = cannot be known (no list price / cost unknown / no revenue).';

create or replace function public.tg_quote_approval_not_by_maker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_tier  text;
  v_note  text;
  v_owner_tier boolean;
  v_in_company boolean;
  v_old_d integer; v_old_m integer;
  v_new_d integer; v_new_m integer;
  v_stale boolean := false;
begin
  if v_uid is null then return new; end if;

  /* R-2447: the below-cost mark (R-2213 money guard) is not taken off by a login while the lines ARE
     below cost (bank_sale_lines_below_cost = linesBelowCost) — the owner approves the quote, or the
     price is raised first. */
  if coalesce(old.below_cost, false) and not coalesce(new.below_cost, false)
     and public.bank_sale_lines_below_cost(new.line_items) then
    raise exception 'Quote % is below cost — that mark cannot be removed while the price is under cost. The owner approves it, or raise the price first.', new.id
      using errcode = '42501';
  end if;

  /* R-2447: an approved quote that stays approved under the same signer. */
  if old.approval_status::text = 'approved' and new.approval_status::text = 'approved'
     and new.approved_by is not distinct from old.approved_by then
    if new.approved_discount_bps is not distinct from old.approved_discount_bps
       and new.approved_margin_bps is not distinct from old.approved_margin_bps
       and new.approval_tier is not distinct from old.approval_tier
       and new.approved_at is not distinct from old.approved_at then
      /* No re-signing. Below cost now, or a line edit that makes the approval stale (isStale in
         lib/quotes/approval.ts) → it needs a fresh approval. */
      if new.line_items is distinct from old.line_items then
        select b.discount_bps, b.margin_bps into v_old_d, v_old_m from public.quote_lines_approval_bps(old.line_items) b;
        select b.discount_bps, b.margin_bps into v_new_d, v_new_m from public.quote_lines_approval_bps(new.line_items) b;
        if v_new_d is distinct from v_old_d
           or v_new_m is distinct from v_old_m then
          v_stale := (old.approved_discount_bps is not null and v_new_d is not null and v_new_d > old.approved_discount_bps)
                  or (old.approved_margin_bps is not null and v_new_m is not null and v_new_m < old.approved_margin_bps)
                  or (old.approved_margin_bps is not null and v_new_m is null)
                  or (old.approved_discount_bps is null and v_new_d is not null and v_new_d > 1000)   -- AUTO_APPROVE_DISCOUNT_BPS
                  or (old.approved_margin_bps is null and v_new_m is not null and v_new_m < 1200);    -- OWNER_MARGIN_FLOOR_BPS
        end if;
      end if;
      if v_stale or (coalesce(new.below_cost, false) and not coalesce(old.below_cost, false)) then
        new.approval_status := 'pending';
        /* the tier the NEW numbers need (requiredApproval): owner when below cost, already owner, margin
           unknown / under 12% or discount over 20%; else manager. */
        new.approval_tier := case when coalesce(new.below_cost, false) or old.approval_tier::text = 'owner'
                                       or (v_stale and (v_new_m is null or v_new_m < 1200 or coalesce(v_new_d, 0) > 2000))
                                  then 'owner' else 'manager' end;
        new.approval_requested_by := v_uid;
        new.approval_requested_at := now();
        new.approved_by := null;
        new.approved_at := null;
        new.approved_discount_bps := null;
        new.approved_margin_bps := null;
        new.approval_rejection_reason := null;
        new.approval_note := null;
        insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
        values (new.tenant_id, v_uid, 'quote.approval_reset', 'quote', new.id,
                case when v_stale then 'Approval cleared: the lines changed after sign-off'
                     else 'Approval cleared: the quote is now below cost' end,
                jsonb_build_object('was_approved_by', old.approved_by,
                                   'was_discount_bps', old.approved_discount_bps, 'was_margin_bps', old.approved_margin_bps,
                                   'now_discount_bps', v_new_d, 'now_margin_bps', v_new_m,
                                   'below_cost', coalesce(new.below_cost, false)));
      end if;
      return new;
    end if;
    /* R-2447 (F1): the signed numbers / tier / approved_at change — that is a signing, checked below. */
  end if;

  /* R-2441: the tier this decision is for — owner when the stored tier is 'owner' before OR after
     this update (no lowering it in the same write), or the quote is below cost (R-2213). */
  v_owner_tier := old.approval_tier::text = 'owner' or new.approval_tier::text = 'owner'
                  or coalesce(new.below_cost, false) or coalesce(old.below_cost, false);
  v_in_company := exists (select 1 from public.users u where u.id = v_uid and u.tenant_id = new.tenant_id);

  /* R-2441: a rejection is a decision too — in the signer's own name, by a role that may decide
     that tier (a sales / billing login cannot reject a teammate's quote in the owner's name). */
  if new.approval_status::text = 'rejected'
     and (old.approval_status::text is distinct from 'rejected' or new.approved_by is distinct from old.approved_by) then
    new.approved_by := v_uid;
    if not (v_in_company and (case when v_owner_tier then public.current_user_has_role('owner')
                                   else public.current_user_has_role('owner', 'manager') end)) then
      raise exception 'Only % can reject % — it is their decision.', case when v_owner_tier then 'the owner' else 'a manager or the owner' end, new.id
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.approval_status::text <> 'approved' then return new; end if;
  /* (R-2447: an approved quote re-saved under the same signer with the same signed numbers already
     returned above — from here on every row is a signing.) */

  /* R-2367: the sign-off is in the signer's own name — a login cannot approve as someone else. */
  new.approved_by := v_uid;

  if v_uid = new.created_by
     or v_uid = new.owner_id
     or v_uid = new.approval_requested_by
     or v_uid = any (public.quote_chain_makers(new.id)) then

    /* R-2426: the company's ONLY active owner may clear their own quote, at any tier, with a
       reason. R-2441: "owner" by the app's own rule (current_user_has_role: active, access not
       ended, MFA when enrolled), of THIS quote's company; another owner counts unless switched
       off or past access_ends_on. */
    v_tier := coalesce(old.approval_tier::text, new.approval_tier::text);   -- for the activity log only; the tier no longer decides

    if not (v_in_company and public.current_user_has_role('owner'))
       or exists (select 1 from public.users u
                   where u.tenant_id = new.tenant_id and u.id <> v_uid
                     and u.is_active is not false
                     and (u.access_ends_on is null or u.access_ends_on >= public.ist_today())
                     and u.role::text = 'owner') then
      raise exception 'You cannot approve % — you made, revised or asked approval for this quote or an earlier version of it. Another approver must clear it.', new.id
        using errcode = '42501';
    end if;

    v_note := btrim(coalesce(new.approval_note, ''));
    if char_length(v_note) < 10 then
      raise exception 'You are the only owner of this company, so approving % yourself needs a reason — write why this price is OK (at least 10 characters).', new.id
        using errcode = '23514';
    end if;
    new.approval_note := v_note;

    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
    values (new.tenant_id, v_uid, 'quote.self_approved', 'quote', new.id,
            'Self-approved by sole owner: ' || v_note,
            jsonb_build_object('reason', v_note, 'tier', v_tier,
                               'approved_discount_bps', new.approved_discount_bps,
                               'approved_margin_bps', new.approved_margin_bps));
    return new;
  end if;

  /* R-2441: a non-maker needs the role for the tier (lib/quotes/approval.ts OWNER_APPROVERS /
     MANAGER_APPROVERS). Owner when: the stored tier is 'owner' (before or after), below cost, or
     the numbers being signed are owner-tier by the same matrix as requiredApproval() — margin
     unknown or under 12% (OWNER_MARGIN_FLOOR_BPS 1200), discount over 20%
     (MANAGER_MAX_DISCOUNT_BPS 2000). So lowering the stored tier in an EARLIER update does not
     let a manager sign owner-tier numbers; signing numbers that are not the quote's makes the
     approval stale on screen (isStale) and the quote cannot be sent. */
  if v_owner_tier
     or new.approved_margin_bps is null or new.approved_margin_bps < 1200
     or coalesce(new.approved_discount_bps, 0) > 2000 then
    if not (v_in_company and public.current_user_has_role('owner')) then
      raise exception 'Only the owner can approve % — it needs owner sign-off.', new.id
        using errcode = '42501';
    end if;
  elsif not (v_in_company and public.current_user_has_role('owner', 'manager')) then
    raise exception 'Only a manager or the owner can approve % — ask one of them to clear it.', new.id
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.tg_quote_approval_not_by_maker() from public, anon, authenticated;

comment on function public.tg_quote_approval_not_by_maker() is
  'R-2367/R-2383/R-2426/R-2441/R-2447: approved_by = the signer; a maker of the quote family is refused unless they are the company''s ONLY owner (current_user_has_role; other owners counted unless switched off or past access_ends_on) and give a reason (min 10 chars), kept in approval_note and activity_log (quote.self_approved). A non-maker needs the owner role for an owner-tier (before or after) or below-cost quote, else owner or manager. R-2447: on an approved quote, a change of the signed numbers / tier / approved_at is a new signing (role checked); below_cost turning true or a line edit that makes the approval stale (isStale) sends it back to pending (activity_log quote.approval_reset).';

drop trigger if exists trg_quote_approval_not_by_maker on public.quotes;
create trigger trg_quote_approval_not_by_maker
  before update of approval_status, approved_by, approved_at, approved_discount_bps, approved_margin_bps,
                   approval_tier, below_cost, line_items on public.quotes
  for each row execute function public.tg_quote_approval_not_by_maker();

create or replace function public.tg_quote_insert_approval_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  /* R-2447: only a login's DIRECT insert — PostgREST (authenticated / anon) or the Cloud SQL data
     gateway (app_runtime / app_anon, src/server/db/gateway.ts; same list as R-1903). Inside a SECURITY
     DEFINER function (combine_quotes, R-1527, copies its sources' approval) current_user is the
     function's owner; a service / cron path runs as service_role — both unchanged. */
  if current_user::text not in ('authenticated', 'anon', 'authenticator', 'app_runtime', 'app_anon') then return new; end if;
  if new.approval_status::text in ('approved', 'rejected') then
    raise exception 'A new quote cannot be saved already % — save it first, then ask for approval (Review & decide).', new.approval_status
      using errcode = '42501';
  end if;
  new.approved_by := null;
  new.approved_at := null;
  new.approved_discount_bps := null;
  new.approved_margin_bps := null;
  return new;
end
$$;

revoke all on function public.tg_quote_insert_approval_guard() from public, anon, authenticated;

comment on function public.tg_quote_insert_approval_guard() is
  'R-2447: a login''s direct insert into quotes cannot be approved / rejected already and keeps no signer or signed numbers. SECURITY DEFINER functions (combine_quotes) and service paths are not affected.';

drop trigger if exists trg_quote_insert_approval_guard on public.quotes;
create trigger trg_quote_insert_approval_guard
  before insert on public.quotes
  for each row execute function public.tg_quote_insert_approval_guard();

commit;
