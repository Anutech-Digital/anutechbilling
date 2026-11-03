-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quote_approval_not_by_maker()') and prosrc like '%R-2441%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_reference_is_real(text)') and prosrc like '%NEFT%')
-- deploy-key: r2441approvalroleprefixedrefs
-- 20261103172531_r2441_approval_role_and_prefixed_refs
--
-- R-2441 (3 Nov 2026) — fixes from the independent money review 2
-- (Anutech-HQ/drafts/REVIEWS/2026-11-03-money-cards-2.md).
--
-- ─── 1. "Who is an owner" uses the app's own role rule (R-2426 should-fix 1 + minor 2) ───
--   R-2426 tested users.role = 'owner' and is_active only. current_user_has_role() — the single
--   definition of "who may touch this" — also needs access not ended (R-1896, access_ends_on)
--   and, for an MFA-enrolled login, a two-step session (R-1556). So an owner whose access had
--   ended (is_active still true) could self-approve, AND counted as a second owner that blocked
--   the real sole owner until someone also switched them off.
--   Now: (a) the maker must hold the owner role by current_user_has_role('owner') and belong to
--   the quote's company; (b) another owner counts only when not switched off (is_active is not
--   false — unknown still counts, the stricter reading) AND their access has not ended.
--
-- ─── 2. The database checks the approver's role for the tier (R-2426 item 4, pre-existing) ───
--   The approval drawer writes approval_status = 'approved' with a direct table UPDATE, and
--   nothing in the database checked that a NON-maker had the role for the tier — a sales or
--   billing login who can see a teammate's quote could approve it. Now, for any signed-in
--   approval (a service / cron path with no login is unchanged), the approver must hold, by
--   current_user_has_role and in the quote's company:
--     • owner — when the tier is 'owner' before OR after the update (a manager cannot lower the
--       tier in the same update to slip past the owner), or the quote is below cost (R-2213:
--       margin < 0, which lib/quotes/approval.ts puts at the owner tier);
--     • owner or manager — otherwise (manager tier, or no tier recorded).
--   Same matrix as MANAGER_APPROVERS / OWNER_APPROVERS in src/lib/quotes/approval.ts. The
--   maker branch (R-2367/R-2383/R-2426) is unchanged apart from fix 1: the sole owner passes it
--   with owner role already.
--
--   Body of tg_quote_approval_not_by_maker() taken from its latest definition (R-2426,
--   20261103153445). Trigger trg_quote_approval_not_by_maker itself is unchanged.
--
-- ─── 3. Placeholder references with a rail prefix (R-2424 should-fix 1) ───
--   bank_reference_is_real (latest: R-2424, 20261103144041) caught '000000000000000' but not
--   'NEFT-000000000000', 'UPI/000000000000', 'UTR:0000000000' or 'IMPS/000000': after keeping
--   letters and digits they read 'NEFT000000000000' — not one repeated character — so two
--   different credits with them still blocked each other. Now leading rail words
--   (NEFT, RTGS, IMPS, UPI, UTR, REF, TXN, NO — any run of them) are set aside before the
--   "one character repeated" test; what is left must be non-empty and not one repeated
--   character. The 6-character minimum still counts the whole reference, and a real UTR with
--   a prefix keeps exactly its R-1676 key (payment_ref_key is unchanged). Same rule as
--   isRealBankReference() in src/lib/payments/bank-reference.ts.
--   Note (R-2424 minor 4, recorded): since R-2424 the 6-character minimum counts letters and
--   digits only, so e.g. '12/3-4' is not keyed.
--   payments_ref_key_idx (an index on payment_ref_key(), which reads this function) is rebuilt.
--
-- Test: supabase/tests/r2441_review_fixes.test.sql
-- (+ r2426_sole_owner_any_tier, r2383_sole_owner_self_approval, r2367_quote_chain_self_approval,
--  r2424_placeholder_bank_ref).

begin;

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
begin
  if v_uid is null then return new; end if;
  if new.approval_status::text <> 'approved' then return new; end if;
  if old.approval_status::text = 'approved' and new.approved_by is not distinct from old.approved_by then
    return new;
  end if;

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

    if not (public.current_user_has_role('owner')
            and exists (select 1 from public.users u
                         where u.id = v_uid and u.tenant_id = new.tenant_id))
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
     MANAGER_APPROVERS). Owner tier before OR after this update, or below cost → owner. */
  if old.approval_tier::text = 'owner' or new.approval_tier::text = 'owner'
     or coalesce(new.below_cost, false) or coalesce(old.below_cost, false) then
    if not (public.current_user_has_role('owner')
            and exists (select 1 from public.users u where u.id = v_uid and u.tenant_id = new.tenant_id)) then
      raise exception 'Only the owner can approve % — it needs owner sign-off.', new.id
        using errcode = '42501';
    end if;
  elsif not (public.current_user_has_role('owner', 'manager')
             and exists (select 1 from public.users u where u.id = v_uid and u.tenant_id = new.tenant_id)) then
    raise exception 'Only a manager or the owner can approve % — ask one of them to clear it.', new.id
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.tg_quote_approval_not_by_maker() from public, anon, authenticated;

comment on function public.tg_quote_approval_not_by_maker() is
  'R-2367/R-2383/R-2426/R-2441: approved_by = the signer; a maker of the quote family is refused unless they are the company''s ONLY owner (current_user_has_role; other owners counted unless switched off or past access_ends_on) and give a reason (min 10 chars), kept in approval_note and activity_log (quote.self_approved). A non-maker needs the owner role for an owner-tier (before or after) or below-cost quote, else owner or manager.';

create or replace function public.bank_reference_is_real(p_reference text)
returns boolean
language sql
immutable
parallel safe
set search_path to 'public'
as $$
  /* R-2424: letters and digits only, upper-case; real = 6+ of them, not a placeholder word, and
     R-2441: what is left after leading rail words (NEFT/RTGS/IMPS/UPI/UTR/REF/TXN/NO) is
     non-empty and not one character repeated — 'NEFT-000000000000' is a placeholder. */
  select length(v) >= 6
     and length(r) > 0
     and length(replace(r, left(r, 1), '')) > 0
     and v <> all (array['NOTAVAILABLE', 'NOTAPPLICABLE', 'NOREFERENCE', 'NOTPROVIDED'])
    from (select v, regexp_replace(v, '^(NEFT|RTGS|IMPS|UPI|UTR|REF|TXN|NO)+', '') as r
            from (select upper(regexp_replace(coalesce(p_reference, ''), '[^A-Za-z0-9]', '', 'g')) as v) s0) s
$$;

comment on function public.bank_reference_is_real(text) is
  'R-2424/R-2441: false for a placeholder bank reference (under 6 letters/digits, a placeholder word, or — after leading NEFT/RTGS/IMPS/UPI/UTR/REF/TXN/NO — empty or one character repeated, such as 000000000000000 or NEFT-000000000000). It is not a UTR and must not block another payment.';

revoke all on function public.bank_reference_is_real(text) from public, anon;
grant execute on function public.bank_reference_is_real(text) to authenticated, service_role;

commit;

reindex index public.payments_ref_key_idx;
