-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.accept_quote(text)') and prosrc like '%R-1762%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_r1762_won_lost_rejects_quote()') and prosrc like '%R-1762b%')
-- deploy-key: r1762reaccept
--
-- R-1762 follow-up (owner's localhost check, 22 Oct 2026, quote Q-R1762-T1):
--   Mark accepted → deal Won → Reopen → deal Quote (20261022120019) → Mark accepted AGAIN → the
--   deal stayed at Quote. accept_quote set leads.stage = 'won' only inside the convert branch
--   (quote has a lead and NO customer yet); after the first accept quotes.customer_id is set and
--   reopen_quote keeps it, so the re-accept skipped the Won update. Mark lost then moved
--   Quote → Lost and left the quote 'accepted' on a lost deal.
--
-- Now:
--   1. accept_quote (body = 20261021025234_r1706, the newest; only one block added): whenever the
--      quote has a lead that is not already Won, the lead becomes Won (stage_changed_at = now()).
--      Every other branch is unchanged. The three ways a deal becomes Won stay the same three.
--   2. tg_r1762_won_lost_rejects_quote: a deal marked Lost from ANY stage rejects its accepted
--      quotes with the lost reason — from Won always (the guard already refused money), from
--      Quote / Demo / Trial only when the deal has no money (r1762_lead_money). No accepted quote
--      hangs on a lost deal.
-- Test: supabase/tests/r1762_won_deal_undo.test.sql (rolled back).

begin;

-- ── 1. accept_quote: every accept makes the linked deal Won ──────────────────
CREATE OR REPLACE FUNCTION public.accept_quote(p_quote_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote        record;
  v_caller       uuid;
  v_tenant       uuid;
  v_customer_id  uuid;
  v_lead         record;
  v_domain       text;
  v_converted    boolean := false;
  v_trusted      boolean;
begin
  /* R-454: who may act WITHOUT a company of their own. Only trusted server paths: the
     service_role key (public quote-accept, cron, webhooks) or a direct database session
     (psql, scripts) that carries no request role at all. A signed-in user with no company
     (customer-portal login, apprentice, mid-signup) is NOT trusted — before R-454 a NULL
     current_tenant_id() skipped the tenant check entirely (fail-open). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the quote''s company can accept it'
      using errcode = '28000';
  end if;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id, q.status,
         q.domain, q.payment_status
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;
  if not found then
    raise exception 'quote % not found', p_quote_id;
  end if;

  if v_caller is not null and v_quote.tenant_id <> v_caller then
    raise exception 'quote % does not belong to your tenant', p_quote_id;
  end if;
  v_tenant := v_quote.tenant_id;

  if v_quote.status = 'rejected' or v_quote.status = 'expired' then
    raise exception 'cannot accept a % quote', v_quote.status;
  end if;

  v_customer_id := v_quote.customer_id;
  v_domain      := v_quote.domain;

  if v_customer_id is null and v_quote.lead_id is not null then
    select l.contact_name, l.contact_email, l.contact_phone, l.company, l.notes, l.domain,
           l.state_code, l.state, l.gstin
      into v_lead
      from public.leads l
     where l.id = v_quote.lead_id
       and l.tenant_id = v_tenant;
    if not found then
      raise exception 'lead % referenced by quote % not found', v_quote.lead_id, p_quote_id;
    end if;

    if v_domain is null then
      v_domain := v_lead.domain;
    end if;

    -- Dedup (R-137, 3 Oct 2026): reuse an existing customer only when it is the same
    -- business — same GSTIN, or same email AND a matching name. See match_existing_customer.
    v_customer_id := public.match_existing_customer(v_tenant, v_lead.contact_email, v_lead.gstin, v_lead.company);

    if v_customer_id is null then
      insert into public.customers (
        tenant_id, name, contact_name, contact_email, contact_phone,
        domain, since, health, notes, state_code, state, gstin
      ) values (
        v_tenant, v_lead.company, v_lead.contact_name, v_lead.contact_email,
        v_lead.contact_phone, v_domain, current_date,
        70,
        v_lead.notes, v_lead.state_code, v_lead.state, v_lead.gstin
      )
      returning id into v_customer_id;
    else
      /* R-373 (7 Oct 2026): the reused customer may have no state (149/160 locally),
         and generate_invoice refuses an invoice without one. The lead in hand carries
         the state the buyer gave (or a GSTIN whose first two digits are the code), so
         fill a BLANK customer state from it — never overwrite one already set. Same
         rule as fillBlankCustomerState on the online path. */
      update public.customers c
         set state_code = case
                            when btrim(coalesce(v_lead.state_code, '')) ~ '^[0-9]{2}$' then btrim(v_lead.state_code)
                            else substring(btrim(v_lead.gstin) from 1 for 2)
                          end,
             state      = case
                            when nullif(btrim(coalesce(c.state, '')), '') is null then v_lead.state
                            else c.state
                          end
       where c.id = v_customer_id
         and c.tenant_id = v_tenant
         and nullif(btrim(coalesce(c.state_code, '')), '') is null
         and (btrim(coalesce(v_lead.state_code, '')) ~ '^[0-9]{2}$'
              or btrim(coalesce(v_lead.gstin, '')) ~ '^[0-9]{2}');
    end if;

    update public.leads
       set stage = 'won'
     where id = v_quote.lead_id
       and tenant_id = v_tenant;

    v_converted := true;
  elsif v_customer_id is null then
    /* R-1706: a PROSPECT quote — no lead, no customer. Create the customer from the quote's own
       name / place of supply / country, the same insert record_payment does for a prospect's
       first payment, so Invoice now and Activate now, pay later have a customer to bill. */
    v_customer_id := public.customer_from_prospect_quote(v_tenant, p_quote_id, 70);
    v_converted := true;
  end if;

  /* R-1762: an accept always makes the linked deal Won — not only the first accept that
     converts the lead. After Reopen (reopen_quote keeps quote.customer_id) a second Mark
     accepted skipped the branch above and the deal stayed at Quote. */
  if v_quote.lead_id is not null then
    update public.leads
       set stage = 'won', stage_changed_at = now()
     where id = v_quote.lead_id
       and tenant_id = v_tenant
       and stage is distinct from 'won';
  end if;

  update public.quotes
     set status      = 'accepted',
         customer_id  = v_customer_id,
         payment_status = case
           when payment_status in ('partial', 'received', 'invoiced') then payment_status
           else 'awaiting'::payment_status
         end
   where id = p_quote_id
     and tenant_id = v_tenant;

  return jsonb_build_object(
    'quote_id',       p_quote_id,
    'customer_id',    v_customer_id,
    'converted_now',  v_converted,
    'quote_status',   'accepted',
    'awaits_payment', true
  );
end;
$function$;

revoke all on function public.accept_quote(text) from public, anon;
grant execute on function public.accept_quote(text) to authenticated, service_role;

-- ── 2. Lost from any stage rejects the accepted quote (R-1762b) ─────────────
create or replace function public.tg_r1762_won_lost_rejects_quote()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ids text;
begin
  /* R-1762b: from Won (the exit guard already refused money) or from an open stage when the
     deal has no money, the accepted quote is rejected with the lost reason. */
  if new.stage = 'lost' and old.stage is distinct from 'lost'
     and (old.stage = 'won' or not public.r1762_lead_money(new.id)) then
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

    if old.stage = 'won' then
      insert into public.lead_activities (tenant_id, lead_id, kind, detail)
      values (new.tenant_id, new.id, 'stage',
              case when v_ids is null then 'Won undone — marked Lost'
                   else format('Won undone — marked Lost; quote %s rejected', v_ids) end);
    elsif v_ids is not null then
      insert into public.lead_activities (tenant_id, lead_id, kind, detail)
      values (new.tenant_id, new.id, 'stage', format('Marked Lost; accepted quote %s rejected', v_ids));
    end if;
  end if;
  return null;
end;
$function$;

revoke all on function public.tg_r1762_won_lost_rejects_quote() from public, anon;

commit;
