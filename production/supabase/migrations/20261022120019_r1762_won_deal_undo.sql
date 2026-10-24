-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.lead_has_money(text)')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.reopen_quote(text)') and prosrc like '%R-1762%')
-- deploy-key: r1762wonundo
--
-- R-1762 (Pardeep, 22 Oct 2026): "deal galti se won ho gayi to isko thik karne ka koi raasta hai"
-- + "won se lost karne ki bhi baat hai".
--
-- Before: Reopen on an accepted quote (reopen_quote) moved only the QUOTE back to Sent; the
-- lead stayed Won, so the mistaken win stayed in the dashboard's Won count and win rate.
-- And a Won deal could not be marked Lost at all (client-only lock, no server rule).
--
-- Now:
--   1. public.lead_has_money(p_lead_id) — true when any quote of the deal has a received
--      payment, a GST invoice that is not void, or a subscription that is not cancelled
--      (an add-seats quote counts: it changed a live subscription), or the deal's project
--      has a payment. Same tenant rule as R-714 (fail closed).
--   2. reopen_quote — the R-714 body and guards unchanged; after the quote goes back to
--      Sent, its lead moves Won → Quote when the lead has no money on any quote and no other
--      accepted quote, with a timeline line "Accept undone — quote <id> reopened". The
--      customer record stays.
--   3. trigger on leads (before update of stage): a Won deal leaves Won only when it has no
--      money — "<name> has a payment or invoice — refund or credit-note it first, then mark
--      it lost." The client checks first; this is the rule nobody can skip.
--   4. trigger on leads (after update of stage): Won → Lost rejects the deal's accepted
--      quotes with the lost reason (rejected_reason / rejected_note), payment status none,
--      and writes a timeline line.
-- The three ways a deal becomes Won (accept, payment, by hand) are not touched.
-- Test: supabase/tests/r1762_won_deal_undo.test.sql (rolled back).

begin;

-- ── 1. Does this deal have money behind it? ─────────────────────────────────
/* The rule itself, with no caller check — used by reopen_quote and the leads triggers, which
   act on a row the caller was already allowed to change (RLS / reopen_quote's own guard).
   Not granted to app roles: the app calls lead_has_money below. */
create or replace function public.r1762_lead_money(p_lead_id text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  with l as (select id, tenant_id, project_id from public.leads where id = p_lead_id)
  select exists (
           select 1
             from l
             join public.quotes q on q.lead_id = l.id and q.tenant_id = l.tenant_id
             join public.payments p on p.quote_id = q.id and p.tenant_id = q.tenant_id
            where p.status = 'received')
      or exists (
           select 1
             from l
             join public.quotes q on q.lead_id = l.id and q.tenant_id = l.tenant_id
             join public.invoices i on i.tenant_id = q.tenant_id
                                   and (i.quote_id = q.id or i.id = q.invoice_id)
            where i.status <> 'void')
      or exists (
           select 1
             from l
             join public.quotes q on q.lead_id = l.id and q.tenant_id = l.tenant_id
            where q.add_seats_subscription_id is not null
               or exists (select 1 from public.subscriptions s
                           where s.quote_id = q.id and s.tenant_id = q.tenant_id
                             and s.status <> 'cancelled'))
      or exists (
           select 1
             from l
             join public.project_payments pp on pp.project_id = l.project_id and pp.tenant_id = l.tenant_id);
$function$;

revoke all on function public.r1762_lead_money(text) from public, anon, authenticated;

/* What the app calls before Mark lost on a Won deal. R-714 tenant rule (fail closed). */
create or replace function public.lead_has_money(p_lead_id text)
 returns boolean
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant  uuid;
  v_caller  uuid;
  v_trusted boolean;
begin
  /* R-1762, R-714 tenant rule: no company and not a trusted server path → refused. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the deal''s company can check it'
      using errcode = '42501';
  end if;

  select tenant_id into v_tenant from public.leads where id = p_lead_id;
  if not found then
    return false;
  end if;
  if not v_trusted and v_tenant is distinct from v_caller then
    raise exception 'Deal % is not in the caller''s company', p_lead_id
      using errcode = '42501';
  end if;

  return public.r1762_lead_money(p_lead_id);
end;
$function$;

revoke all on function public.lead_has_money(text) from public, anon;
grant execute on function public.lead_has_money(text) to authenticated, service_role;

comment on function public.lead_has_money(text) is
  'R-1762: true when the deal (lead) has a received payment, a non-void invoice or a live subscription on any of its quotes, or a project payment. A Won deal with money cannot leave Won.';

-- ── 2. reopen_quote: undo the accept on the deal too ────────────────────────
CREATE OR REPLACE FUNCTION public.reopen_quote(p_quote_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote   record;
  v_caller  uuid;
  v_trusted boolean;
begin
  /* R-714: no company AND not a trusted server path → refused. Before R-714 a NULL
     current_tenant_id() skipped the tenant check below (fail-open). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the quote''s company can reopen it'
      using errcode = '42501';
  end if;

  select id, tenant_id, status, payment_status, invoice_id, lead_id
    into v_quote
    from public.quotes where id = p_quote_id
    for update;
  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;

  if not v_trusted
     and v_quote.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in the caller''s tenant', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Only an accepted quote can be reopened (this one is %)', v_quote.status
      using errcode = 'check_violation';
  end if;

  -- Money guard — never reopen once a payment or invoice exists.
  if v_quote.invoice_id is not null
     or v_quote.payment_status in ('received', 'partial', 'invoiced')
     or exists (select 1 from public.payments p where p.quote_id = p_quote_id and p.status = 'received') then
    raise exception 'Can''t reopen — this quote has a payment or invoice. Reverse those first.'
      using errcode = 'check_violation';
  end if;

  update public.quotes
     set status = 'sent', payment_status = 'none'::payment_status
   where id = p_quote_id;

  /* R-1762: the accept made the deal Won — undo that too, so the mistaken win leaves the
     Won count. Only when nothing else keeps it Won: no money on any of the deal's quotes and
     no other accepted quote. The customer record stays (it may already be used elsewhere). */
  if v_quote.lead_id is not null
     and exists (select 1 from public.leads l
                  where l.id = v_quote.lead_id and l.tenant_id = v_quote.tenant_id and l.stage = 'won')
     and not exists (select 1 from public.quotes q
                      where q.lead_id = v_quote.lead_id and q.tenant_id = v_quote.tenant_id
                        and q.id <> p_quote_id and q.status = 'accepted')
     and not public.r1762_lead_money(v_quote.lead_id) then
    update public.leads
       set stage = 'quote', stage_changed_at = now()
     where id = v_quote.lead_id and tenant_id = v_quote.tenant_id;

    insert into public.lead_activities (tenant_id, lead_id, kind, detail)
    values (v_quote.tenant_id, v_quote.lead_id, 'stage',
            format('Accept undone — quote %s reopened; deal moved back to Quote', p_quote_id));
  end if;
end;
$function$;

-- ── 3. A Won deal leaves Won only without money ─────────────────────────────
create or replace function public.tg_r1762_won_exit_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if old.stage = 'won' and new.stage is distinct from 'won'
     and public.r1762_lead_money(old.id) then
    raise exception '% has a payment or invoice — refund or credit-note it first, then mark it lost.',
      coalesce(nullif(trim(old.company), ''), 'This deal')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

revoke all on function public.tg_r1762_won_exit_guard() from public, anon;

drop trigger if exists trg_r1762_won_exit_guard on public.leads;
create trigger trg_r1762_won_exit_guard
  before update of stage on public.leads
  for each row execute function public.tg_r1762_won_exit_guard();

-- ── 4. Won → Lost: the accepted quote is rejected with the lost reason ───────
create or replace function public.tg_r1762_won_lost_rejects_quote()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ids text;
begin
  if old.stage = 'won' and new.stage = 'lost' then
    with rejected as (
      update public.quotes q
         set status          = 'rejected',
             payment_status  = 'none'::payment_status,
             rejected_reason = new.lost_reason,
             rejected_note   = new.lost_note
       where q.lead_id = new.id
         and q.tenant_id = new.tenant_id
         and q.status = 'accepted'
      returning q.id
    )
    select string_agg(id, ', ' order by id) into v_ids from rejected;

    insert into public.lead_activities (tenant_id, lead_id, kind, detail)
    values (new.tenant_id, new.id, 'stage',
            case when v_ids is null then 'Won undone — marked Lost'
                 else format('Won undone — marked Lost; quote %s rejected', v_ids) end);
  end if;
  return null;
end;
$function$;

revoke all on function public.tg_r1762_won_lost_rejects_quote() from public, anon;

drop trigger if exists trg_r1762_won_lost_rejects_quote on public.leads;
create trigger trg_r1762_won_lost_rejects_quote
  after update of stage on public.leads
  for each row execute function public.tg_r1762_won_lost_rejects_quote();

commit;
