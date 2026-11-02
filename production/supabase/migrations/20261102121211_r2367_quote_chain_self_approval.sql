-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_quote_approval_not_by_maker' and tgrelid = to_regclass('public.quotes')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.quote_chain_makers(text)') and prosrc like '%R-2367%')
-- deploy-key: r2367chainapproval
-- 20261102121211_r2367_quote_chain_self_approval
--
-- WHAT THIS CHANGES (R-2367, p1 security — staging reconcile 2 Nov 2026)
--   The app refused approving your own NEW below-cost quote, but after "Revise" the -R2 copies
--   (Q-A378-27-0565-R2..0567-R2, 0880-R2) were approved by the same person. Two holes:
--     1. The self-approval rule lived only in the browser (lib/quotes/approval.ts canApprove)
--        and keyed on approval_requested_by alone. A revision starts with no approval record,
--        so requested_by is NULL and the person who made the quote saw "Approve".
--     2. Approving is a plain `update quotes set approval_status='approved'` from the browser
--        — nothing on the server stopped anyone approving any quote, in anyone's name.
--
--   Now:
--     a. quotes.created_by — who made the row (set from the login on insert; a revision is
--        a new row, so the reviser is its created_by).
--     b. quote_chain_makers(quote_id) — everyone who made, revised, owns or asked approval for
--        ANY quote of the revision family (the root and every -Rn).
--     c. trg_quote_approval_not_by_maker (BEFORE UPDATE): a login moving a quote to 'approved'
--        must not be one of those people, and the sign-off is always recorded in the signer's
--        own name (approved_by := the login). Same rule for every role — owners included,
--        exactly as the app already had it ("Nobody approves their own quote. Not even an
--        owner." — approval.ts). Service/cron/definer paths with no login are unchanged.
--   Rejecting is not blocked (a maker rejecting their own quote changes nothing in money).
--
--   Old rows have created_by NULL; for them the family's owner_id and approval_requested_by
--   are what is known. Nothing is back-filled.

begin;

alter table public.quotes add column if not exists created_by uuid;
comment on column public.quotes.created_by is
  'R-2367: the login that inserted this quote row (a revision is its own row, so this is the reviser). Used by quote_chain_makers() — nobody who made or revised a quote family may approve it. NULL on rows made before 2 Nov 2026 or by a service path.';

-- ── a. created_by from the login, never from the client ─────────────────────────────────
create or replace function public.tg_quote_created_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  /* R-2367: the login wins over anything the client sends; a service path (no login) may set it. */
  new.created_by := coalesce(auth.uid(), new.created_by);
  return new;
end
$$;

drop trigger if exists trg_quote_created_by on public.quotes;
create trigger trg_quote_created_by
  before insert on public.quotes
  for each row execute function public.tg_quote_created_by();

-- ── b. who made any quote of this family ────────────────────────────────────────────────
create or replace function public.quote_chain_makers(p_quote_id text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  /* R-2367: everyone who created, revised, owns or requested approval for any quote of the
     revision family of p_quote_id (root + every -Rn). Only for the caller's own tenant when
     a login calls it; the trigger below calls it for the row being updated. */
  with me as (
    select q.tenant_id, coalesce(q.revision_of, q.id) as root
      from public.quotes q
     where q.id = p_quote_id
       and (auth.uid() is null or q.tenant_id = public.current_tenant_id())
  ), fam as (
    select f.created_by, f.owner_id, f.approval_requested_by
      from public.quotes f, me
     where f.tenant_id = me.tenant_id
       and (f.id = me.root or f.revision_of = me.root)
  )
  select coalesce(array_agg(distinct u) filter (where u is not null), '{}'::uuid[])
    from (select created_by as u from fam
          union all select owner_id from fam
          union all select approval_requested_by from fam) x
$$;

revoke all on function public.quote_chain_makers(text) from public, anon;
grant execute on function public.quote_chain_makers(text) to authenticated, service_role;

-- ── c. the server-side rule ─────────────────────────────────────────────────────────────
create or replace function public.tg_quote_approval_not_by_maker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
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
    raise exception 'You cannot approve % — you made, revised or asked approval for this quote or an earlier version of it. Another approver must clear it.', new.id
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.tg_quote_approval_not_by_maker() from public, anon, authenticated;

drop trigger if exists trg_quote_approval_not_by_maker on public.quotes;
create trigger trg_quote_approval_not_by_maker
  before update of approval_status, approved_by on public.quotes
  for each row execute function public.tg_quote_approval_not_by_maker();

commit;
