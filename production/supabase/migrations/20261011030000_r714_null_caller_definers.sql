-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.accept_project_quote(uuid)') and prosrc like '%R-714%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reopen_quote(text)') and prosrc like '%R-714%')
-- deploy-key: r714definers
--
-- R-714 (P0 SECURITY, audit 10 Oct 2026): the last two quote definers fail CLOSED.
--
-- "Null-caller" = a signed-in login with no public.users row (customer-portal login,
-- apprentice, mid-signup). current_tenant_id() is NULL for them.
--
--   accept_project_quote(p_project_id) had NO tenant check at all: any signed-in user —
--     including another company's member — could turn any company's 'quoted' project into
--     'active' (and create a customer in that company).
--   reopen_quote(p_quote_id) guarded with
--     if current_tenant_id() is not null and <row tenant> is distinct from current_tenant_id()
--     so a null-caller skipped the check and could move another company's accepted quote
--     back to 'sent'. Quote ids are guessable (Q-<code>-<fy>-<n>).
--
-- The other five functions named in the audit (accept_quote, generate_invoice,
-- raise_subscription_billing, next_document_number, next_customer_number) were already
-- made fail-closed by R-454 (20261010190000_tenant_guard_fail_closed) — re-checked, not
-- touched here; the R-714 attack test covers all seven.
--
-- Now (same trust rule as R-454):
--   trusted = auth.role() = 'service_role' (public /api/public/project-quote/<id>/accept uses
--             the admin client) or a direct DB session with no request role (psql/scripts).
--   not trusted + no company            → refused, SQLSTATE 42501.
--   not trusted + another company's row → refused, SQLSTATE 42501.
--   own company / trusted               → unchanged behaviour.
-- Bodies are the newest definitions (baseline.sql — no later migration redefines either)
-- with ONLY the guard lines added/changed. Signatures unchanged, so grants are kept.
-- Staging: the deploy script rewrites auth.role() -> public.current_request_role() (R-161).
-- Test: supabase/tests/r714_null_caller_definers.test.sql (rolled back).

begin;

CREATE OR REPLACE FUNCTION public.accept_project_quote(p_project_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status  text;
  v_tenant  uuid;
  v_cust    uuid;
  v_name    text;
  v_caller  uuid;
  v_trusted boolean;
begin
  /* R-714: who may act WITHOUT a company of their own — only trusted server paths (the
     service_role key used by the public project-quote accept route, or a direct database
     session with no request role). Before R-714 there was no tenant check at all. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the project''s company can accept it'
      using errcode = '42501';
  end if;

  select status, tenant_id, customer_id, customer_name
    into v_status, v_tenant, v_cust, v_name
    from public.project_sales where id = p_project_id;
  if not found then raise exception 'Quotation not found' using errcode = 'no_data_found'; end if;

  -- R-714: a signed-in caller may only accept their own company's project.
  if not v_trusted and v_tenant is distinct from v_caller then
    raise exception 'Quotation is not in the caller''s company' using errcode = '42501';
  end if;

  if v_status = 'active' then return 'already'; end if;
  if v_status <> 'quoted' then
    raise exception 'This quotation cannot be accepted (status %)', v_status using errcode = 'invalid_parameter_value';
  end if;

  if v_cust is null then
    select id into v_cust
      from public.customers
     where tenant_id = v_tenant and lower(name) = lower(trim(coalesce(v_name, '')))
     limit 1;
    if v_cust is null and length(trim(coalesce(v_name, ''))) > 0 then
      insert into public.customers (tenant_id, name, since, health)
      values (v_tenant, trim(v_name), current_date, 70)
      returning id into v_cust;
    end if;
  end if;

  update public.project_sales
     set status = 'active', accepted_at = now(), customer_id = v_cust, updated_at = now()
   where id = p_project_id;

  if v_cust is not null then
    update public.invoices i
       set customer_id = v_cust
      from public.project_milestones m
     where m.project_id = p_project_id
       and i.id = m.invoice_id
       and i.customer_id is null;
  end if;

  return 'accepted';
end;
$function$;

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

  select id, tenant_id, status, payment_status, invoice_id
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
end;
$function$;

commit;
