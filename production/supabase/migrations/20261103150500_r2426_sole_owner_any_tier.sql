-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quote_approval_not_by_maker()') and prosrc like '%R-2426%')
-- deploy-key: r2426soleownersanytier
-- 20261103150500_r2426_sole_owner_any_tier
--
-- WHAT THIS CHANGES (R-2426, p0 — Pardeep 3 Nov 2026: "single owner ko ye power honi chahiye live me bhi")
--   R-2383 (20261102132142) let a maker approve their own quote only when NOBODY else active in
--   the company had a role that may approve that tier — so on a manager-tier (or no-tier) quote
--   an active MANAGER login counted as "another approver". Staging 3 Nov: a one-owner company
--   with a manager login → the owner saw "You cannot approve your own quote" on their own
--   below-floor quote, with no way on.
--
--   Now a maker may approve ONLY when all three hold:
--     (a) they are an ACTIVE owner (users.is_active true) of the quote's company;
--     (b) the company has no OTHER owner who is not switched off (is_active is not false —
--         an unknown flag counts as a second owner, the stricter reading). Managers and other
--         roles no longer matter: the sole owner decides at any tier;
--     (c) a reason of at least 10 characters is given in quotes.approval_note.
--   Unchanged: the reason is kept on the quote (approval_note, trimmed) and written to
--   activity_log as "Self-approved by sole owner: <reason>" (action 'quote.self_approved');
--   any other maker (non-owner, inactive owner, owner of another company, one of two owners)
--   stays refused; the other owner approves as before.
--
--   Body of tg_quote_approval_not_by_maker() taken from its latest definition (R-2383,
--   20261102132142) — only the "who is the sole owner" test and the no-reason message change.
--   Trigger trg_quote_approval_not_by_maker itself is unchanged.
-- Test: supabase/tests/r2426_sole_owner_any_tier.test.sql (+ r2383_sole_owner_self_approval.test.sql E1).

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
       reason. Owner of THIS quote's company, active; no other owner who is not switched off. */
    v_tier := coalesce(old.approval_tier::text, new.approval_tier::text);   -- for the activity log only; the tier no longer decides

    if not exists (select 1 from public.users u
                    where u.id = v_uid and u.tenant_id = new.tenant_id
                      and u.role::text = 'owner' and u.is_active is true)
       or exists (select 1 from public.users u
                   where u.tenant_id = new.tenant_id and u.id <> v_uid
                     and u.is_active is not false
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
  end if;
  return new;
end
$$;

revoke all on function public.tg_quote_approval_not_by_maker() from public, anon, authenticated;

comment on function public.tg_quote_approval_not_by_maker() is
  'R-2367/R-2383/R-2426: approved_by = the signer; a maker of the quote family is refused unless they are the company''s ONLY active owner and give a reason (min 10 chars), which is kept in approval_note and activity_log (quote.self_approved).';

commit;
