-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'approval_note') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quote_approval_not_by_maker()') and prosrc like '%R-2383%')
-- deploy-key: r2383soleownerapproval
-- 20261102132142_r2383_sole_owner_self_approval
--
-- WHAT THIS CHANGES (R-2383, p1 — owner decision 2 Nov 2026: "Haan, reason ke saath")
--   R-2367 (20261102121211) refuses anyone who made, revised, owns or asked approval for any
--   quote of a revision family — owners included. A company with ONE owner and nobody else who
--   may approve (Excel Technologies) can then never approve a quote made under the owner login:
--   a dead end.
--
--   Now a maker may approve ONLY when all three hold:
--     (a) they are an active OWNER of the quote's company;
--     (b) the company has no OTHER active user whose role may approve this quote — the app's
--         approver roles (lib/quotes/approval.ts): owner tier → owner; manager tier → owner,
--         manager; no tier recorded → owner, manager (the stricter reading);
--     (c) a reason of at least 10 characters is given in quotes.approval_note.
--   The reason is kept on the quote (approval_note, trimmed) and written to activity_log as
--   "Self-approved by sole owner: <reason>" (action 'quote.self_approved').
--   Any other maker stays refused; once a second approver exists, the owner is refused again.
--
--   Body of tg_quote_approval_not_by_maker() taken from its latest definition (R-2367,
--   20261102121211) — only the maker branch changes. Trigger itself is unchanged.

begin;

alter table public.quotes add column if not exists approval_note text;
comment on column public.quotes.approval_note is
  'R-2383: the written reason when the company''s sole owner approved a quote they made or revised (min 10 characters, enforced by trg_quote_approval_not_by_maker). Cleared when approval is asked for again.';

create or replace function public.tg_quote_approval_not_by_maker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_tier  text;
  v_roles text[];
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

    /* R-2383: the company's sole approver (an owner) may clear their own quote with a reason.
       Roles that may approve = the app's MANAGER_APPROVERS / OWNER_APPROVERS for the tier. */
    v_tier  := coalesce(old.approval_tier::text, new.approval_tier::text);
    v_roles := case when v_tier = 'owner' then array['owner'] else array['owner', 'manager'] end;

    if not exists (select 1 from public.users u
                    where u.id = v_uid and u.tenant_id = new.tenant_id
                      and u.role::text = 'owner' and u.is_active is not false)
       or exists (select 1 from public.users u
                   where u.tenant_id = new.tenant_id and u.id <> v_uid
                     and u.is_active is not false
                     and u.role::text = any (v_roles)) then
      raise exception 'You cannot approve % — you made, revised or asked approval for this quote or an earlier version of it. Another approver must clear it.', new.id
        using errcode = '42501';
    end if;

    v_note := btrim(coalesce(new.approval_note, ''));
    if char_length(v_note) < 10 then
      raise exception 'You are the only approver of % — write why this price is OK (at least 10 characters).', new.id
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

commit;
