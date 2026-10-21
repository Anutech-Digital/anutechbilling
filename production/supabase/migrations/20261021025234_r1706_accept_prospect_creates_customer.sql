-- deploy-peek: to_regprocedure('public.customer_from_prospect_quote(uuid,text,integer)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.accept_quote(text)') and prosrc like '%R-1706%')
-- deploy-key: r1706acceptprospect
-- 20261021025234_r1706_accept_prospect_creates_customer.sql
--
-- R-1706 (P1, 21 Oct 2026) — accepting a PROSPECT quote (no lead, no customer) creates the customer.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   Billing audit (localhost): New quote → New prospect without email, place of supply Delhi
--   (prospect_state_code 07) → Mark accepted. accept_quote only converted a LEAD; with no lead
--   and no customer it set status 'accepted' and left quote.customer_id NULL. Then:
--     • "Invoice now" → generate_invoice reads the state only from customers, found none, and said
--       "<name> has no state on record … Customers → <name> → Edit" — a customer that did not exist.
--     • "Activate now, pay later" → "Accept it … so the customer is created" — it was accepted.
--   Only Record payment worked, because record_payment's first-payment branch creates the customer
--   from the quote's prospect fields.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   customer_from_prospect_quote(tenant, quote, health) — the prospect → customer insert that
--   record_payment does inline (20261019164713_r1688, "v_quote.customer_id is null and
--   v_quote.lead_id is null" branch), as ONE function: name = customer_name (else 'Customer'),
--   domain = quote.domain, state_code / state / country = prospect_state_code / prospect_state /
--   prospect_country (country default 'India'). Same columns, same defaults. A quote carries no
--   prospect email / phone / GSTIN column, so there is nothing more to copy.
--   accept_quote (body = 20261010190000_tenant_guard_fail_closed, the newest) calls it when the
--   quote has neither a customer nor a lead, links quote.customer_id and returns converted_now
--   true. Health 70, as the lead branch. Idempotent: a quote that has a customer is untouched.
--   record_payment is NOT redefined here (another card is changing it); switching its inline
--   insert to this function is a follow-up — the columns written are identical meanwhile.
--   The helper is internal (SECURITY DEFINER, R-454 guard): no EXECUTE for anon / authenticated.

begin;

create or replace function public.customer_from_prospect_quote(
  p_tenant uuid, p_quote_id text, p_health integer default 70
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_q       record;
  v_id      uuid;
  v_caller  uuid;
  v_trusted boolean;
begin
  /* R-1706: internal — no EXECUTE for anon / authenticated; called from accept_quote. Still
     guarded fail-closed (§17c / R-454) so a wrong tenant/quote pair can never cross. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — cannot create a customer from a quote'
      using errcode = '28000';
  end if;
  if v_caller is not null and p_tenant is distinct from v_caller then
    raise exception 'quote % does not belong to your tenant', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;

  select q.id, q.tenant_id, q.customer_id, q.lead_id, q.customer_name, q.domain,
         q.prospect_state_code, q.prospect_state, q.prospect_country
    into v_q
    from public.quotes q
   where q.id = p_quote_id and q.tenant_id = p_tenant;
  if not found then
    raise exception 'quote % not found in this company', p_quote_id;
  end if;
  if v_q.customer_id is not null then
    return v_q.customer_id;
  end if;
  if v_q.lead_id is not null then
    raise exception 'quote % is linked to a lead — convert the lead, not the prospect fields', p_quote_id;
  end if;

  insert into public.customers (tenant_id, name, domain, since, health, state_code, state, country)
  values (p_tenant, coalesce(nullif(trim(v_q.customer_name), ''), 'Customer'),
          v_q.domain, current_date, coalesce(p_health, 70),
          v_q.prospect_state_code, v_q.prospect_state,
          coalesce(nullif(trim(v_q.prospect_country), ''), 'India'))
  returning id into v_id;
  return v_id;
end;
$function$;

revoke all on function public.customer_from_prospect_quote(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.customer_from_prospect_quote(uuid, text, integer) to service_role;

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

commit;
