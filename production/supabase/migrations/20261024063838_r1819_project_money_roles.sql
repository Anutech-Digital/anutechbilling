-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.raise_project_milestone_invoice(uuid)') and prosrc like '%R-1819%' and prosrc ilike '%current_user_has_role%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.create_project_direct_invoice(uuid,text,text,text,jsonb,integer,boolean)') and prosrc like '%R-1819%' and prosrc ilike '%current_user_has_role%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.create_project_quote(uuid,text,text,text,jsonb,integer,boolean,jsonb)') and prosrc like '%R-1819%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.accept_project_quote(uuid)') and prosrc like '%R-1819%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.cancel_subscription(uuid,date,text,boolean)') and prosrc like '%R-1819%')
-- deploy-key: r1819projectmoneyroles
-- 20261024063838_r1819_project_money_roles.sql
--
-- R-1819 (P1 SECURITY, security audit 24 Oct 2026): the project functions check the caller's ROLE.
--
-- ══ WHAT WAS OPEN ════════════════════════════════════════════════════════════════════════
--   raise_project_milestone_invoice and create_project_direct_invoice are SECURITY DEFINER,
--   executable by authenticated, and checked only the company — not the role. Any member
--   (sales, support, delivery) could issue a GST Tax Invoice: the audit's local rollback had a
--   sales user issue ₹1,18,000 (milestone) and ₹59,000 (direct) Tax Invoices. create_direct_invoice
--   and generate_invoice have refused that since R-718 / R-885; the project path went round them.
--   accept_project_quote (turns a quotation into an invoiceable project) and create_project_quote
--   had no role check either.
--
-- ══ WHAT CHANGES (guards only — each body is the newest definition, copied exactly) ═══════
--   Roles (decided 24 Oct, recorded on R-1819):
--     raise_project_milestone_invoice, create_project_direct_invoice, accept_project_quote
--       → owner, manager, accountant, billing (the money roles of create_direct_invoice /
--         generate_invoice / record_project_payment).
--     create_project_quote → owner, manager, sales_senior, sales, billing, delivery, accountant —
--       the people who sell keep raising quotations (Project Sales page, "Project quotation"
--       from a lead via create_project_quote_from_lead). Not support / partner_agent.
--     A sales user's quotation becomes a project when the CUSTOMER accepts it on the public
--     link (/api/public/project-quote/[id]/accept — service_role, trusted) or a money role
--     presses "Mark accepted"; the project page now shows those two buttons to money roles only.
--   §17c (production/CLAUDE.md): trusted = service_role or a direct DB session with no request
--   role; anyone else needs a company (28000) and the role (42501).
--   Nested calls keep working: create_project_direct_invoice (money role) → create_project_quote
--   → accept_project_quote → raise_project_milestone_invoice run as the same money-role caller;
--   record_project_receipt_with_tds is money-gated already (R-885); create_project_quote_from_lead
--   (sales) → create_project_quote (sales allowed).
--   cancel_subscription (R-1711 body, 20261024023359): the same §17c shape — its company and role
--   checks ran only when the request role was anon/authenticated, so a session with no request
--   role from the app's own login (authenticator / app_runtime) skipped both.
--
--   Bodies: raise_project_milestone_invoice + create_project_direct_invoice from 20261023202157_r1803,
--   create_project_quote from 20261011072600_r715, accept_project_quote from 20261024030326_r1816,
--   cancel_subscription from 20261024023359_r1711. Grants are kept (create or replace keeps the ACL).
--
-- Proof: supabase/tests/r1819_project_money_roles.test.sql (one rollback, local Docker; without
-- this migration it FAILs at step 1 — sales issues the invoice; removing any one function's role
-- check turns it red).

begin;

CREATE OR REPLACE FUNCTION public.raise_project_milestone_invoice(p_milestone_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_r1819_trusted boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_ms       record;
  v_proj     record;
  v_id       text;
  v_paid     integer;
  v_full     boolean;
  v_pay_date date;
  v_inv_date date;
  v_rate     integer;
  v_taxable  integer;
  v_tax      integer;
  v_lines    jsonb;
  v_r1803_problem text;
begin
  /* R-1819 (security audit 24 Oct 2026): role + company guard (production/CLAUDE.md §17c).
     Trusted = service_role (admin client) or a direct DB session with no request role. */
  v_r1819_trusted := coalesce(auth.role(), '') = 'service_role'
                     or (auth.role() is null
                         and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if public.current_tenant_id() is null and not v_r1819_trusted then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_r1819_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can raise a project invoice' using errcode = '42501';
  end if;
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  /* R-013 (Pardeep, 27 Sep 2026): the hardened form. The old guard opened by testing
     that the tenant was NOT null and only then comparing — so a NULL tenant skipped the
     comparison entirely, which is the anon case and the signed-in-but-no-users-row case,
     and quote/invoice ids are countable. Migration 20260927100000 rewrote 17 definer RPCs
     by regex; this file recreates one of them, so it must carry the hardened shape
     forward or it silently undoes that fix.

     The old wording is deliberately NOT quoted here. `definer_rpc_hardening.test.sql`
     FAIL 4 scans `pg_get_functiondef`, which includes COMMENTS — so writing the phrase in
     prose turns that security test red for no reason (AGENTS.md L46). Verified: quoting it
     did exactly that. */
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated'))
     or (v_tenant is not null and v_ms.tenant_id is distinct from v_tenant) then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_ms.invoice_id is not null then
    raise exception 'Invoice % already raised for this milestone', v_ms.invoice_id
      using errcode = 'unique_violation';
  end if;

  /* R-1803 (R-1643 follow-up): no project Tax Invoice without the company's own GSTIN +
     address (Bill of Supply: address) — checked before the number below is taken. */
  v_r1803_problem := public.supplier_invoice_problem(v_ms.tenant_id, public.ist_today());
  if v_r1803_problem is not null then
    raise exception '%', v_r1803_problem using errcode = 'check_violation';
  end if;

  select * into v_proj from public.project_sales where id = v_ms.project_id;

  select coalesce(sum(amount), 0), min(received_at)
    into v_paid, v_pay_date
    from public.project_payments where milestone_id = p_milestone_id;
  v_full := v_paid >= v_ms.total_amount;

  -- R-003. Was: the first payment's date when fully paid. The number is allocated
  -- below, from today's series, so any earlier date puts the two out of step.
  v_inv_date := public.ist_today();

  v_rate    := coalesce(v_proj.gst_rate, 18);
  v_taxable := round(v_ms.total_amount * 100.0 / (100 + v_rate));
  v_tax     := v_ms.total_amount - v_taxable;

  /* R-010. ONE line, qty 1, rate = this milestone's taxable value — so qty × rate is the
     amount and the document cannot contradict itself. The SAC comes from the project, not
     from a literal: `project_sales.sac_code` is NOT NULL and defaults to 998314. */
  v_lines := jsonb_build_array(jsonb_build_object(
    'id',          'milestone-' || v_ms.seq::text,
    'name',        coalesce(nullif(btrim(v_proj.title), ''), 'Project services')
                   || ' — '
                   || coalesce(nullif(btrim(v_ms.label), ''), 'Milestone ' || v_ms.seq::text),
    'description', nullif(btrim(coalesce(v_proj.description, '')), ''),
    'qty',         1,
    'rate',        v_taxable,
    'cost',        0,
    'hsn',         v_proj.sac_code
  ));

  v_id := public.next_document_number('invoice', v_ms.tenant_id, public.ist_today());
  if v_id is null then raise exception 'Could not allocate invoice number'; end if;

  insert into public.invoices
    (id, tenant_id, customer_id, customer_name, amount, status,
     invoice_date, due_date, paid_date, adjusted_advances, net_payable, quote_id,
     taxable_value, tax_amount, tax_rate, inter_state, line_items)
  values
    (v_id, v_ms.tenant_id, v_proj.customer_id, v_proj.customer_name, v_ms.total_amount,
     (case when v_full then 'paid' else 'pending' end)::invoice_status,
     v_inv_date, greatest(coalesce(v_ms.due_date, v_inv_date), v_inv_date),
     -- The money's own date, not the document's. An advance really did arrive then.
     case when v_full then v_pay_date else null end,
     '[]'::jsonb,
     case when v_full then 0 else v_ms.total_amount end,
     null,
     v_taxable, v_tax, v_rate, coalesce(v_proj.inter_state, false), v_lines);

  update public.project_milestones
     set invoice_id = v_id,
         status     = case when v_full then 'paid' else 'invoiced' end
   where id = p_milestone_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_project_direct_invoice(p_customer_id uuid, p_customer_name text, p_title text, p_description text, p_line_items jsonb, p_gst_rate integer, p_inter_state boolean)
 RETURNS TABLE(invoice_id text, project_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_r1819_trusted boolean;
  v_lines   jsonb;
  v_taxable integer := 0;
  v_gst     integer;
  v_total   integer;
  v_pid     uuid;
  v_msid    uuid;
  v_inv     text;
  v_r1803_problem text;
begin
  /* R-1819 (security audit 24 Oct 2026): role + company guard (production/CLAUDE.md §17c).
     Trusted = service_role (admin client) or a direct DB session with no request role. */
  v_r1819_trusted := coalesce(auth.role(), '') = 'service_role'
                     or (auth.role() is null
                         and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if public.current_tenant_id() is null and not v_r1819_trusted then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_r1819_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can create a project invoice' using errcode = '42501';
  end if;
  if jsonb_typeof(p_line_items) <> 'array' or jsonb_array_length(p_line_items) = 0 then
    raise exception 'At least one line item is required';
  end if;

  /* R-1803 (R-1643 follow-up): refuse before the project, its quote number and its milestone
     are made (raise_project_milestone_invoice checks again before the invoice number). */
  if public.current_tenant_id() is not null then
    v_r1803_problem := public.supplier_invoice_problem(public.current_tenant_id(), public.ist_today());
    if v_r1803_problem is not null then
      raise exception '%', v_r1803_problem using errcode = 'check_violation';
    end if;
  end if;

  select coalesce(jsonb_agg(
           li || jsonb_build_object('amount',
             coalesce(nullif((li->>'amount'), '')::int,
                      coalesce((li->>'qty')::int, 1) * coalesce((li->>'rate')::int, 0)))
         ), '[]'::jsonb)
    into v_lines from jsonb_array_elements(p_line_items) li;

  select coalesce(sum(greatest(coalesce((li->>'amount')::int, 0), 0)), 0)
    into v_taxable from jsonb_array_elements(v_lines) li;
  if v_taxable <= 0 then raise exception 'Invoice total must be greater than zero'; end if;
  v_gst   := round(v_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := v_taxable + v_gst;

  v_pid := public.create_project_quote(
    p_customer_id, p_customer_name, p_title, p_description, v_lines,
    coalesce(p_gst_rate, 18), coalesce(p_inter_state, false),
    jsonb_build_array(jsonb_build_object('label', 'Full amount', 'total_amount', v_total, 'due_date', current_date::text))
  );

  perform public.accept_project_quote(v_pid);

  -- THE ONE CHANGE: `pm` alias so `pm.project_id` is unmistakably the column, not this
  -- function's OUT variable of the same name.
  select pm.id into v_msid
    from public.project_milestones pm
   where pm.project_id = v_pid
   order by pm.seq
   limit 1;
  if v_msid is null then raise exception 'Milestone was not created for project %', v_pid; end if;

  v_inv := public.raise_project_milestone_invoice(v_msid);

  return query select v_inv, v_pid;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_project_quote(p_customer_id uuid, p_customer_name text, p_title text, p_description text, p_line_items jsonb, p_gst_rate integer, p_inter_state boolean, p_milestones jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_r1819_trusted boolean;
  v_tenant  uuid := public.current_tenant_id();
  v_taxable integer := 0;
  v_gst     integer;
  v_total   integer;
  v_id      uuid;
  v_li      jsonb;
  v_m       jsonb;
  v_seq     integer := 0;
begin
  /* R-1819 (security audit 24 Oct 2026): role + company guard (production/CLAUDE.md §17c).
     Trusted = service_role (admin client) or a direct DB session with no request role. */
  v_r1819_trusted := coalesce(auth.role(), '') = 'service_role'
                     or (auth.role() is null
                         and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if public.current_tenant_id() is null and not v_r1819_trusted then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_r1819_trusted and not public.current_user_has_role('owner', 'manager', 'sales_senior', 'sales', 'billing', 'delivery', 'accountant') then
    raise exception 'Your role cannot create a project quotation' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  -- R-715: the customer must belong to the caller's company.
  if p_customer_id is not null and not exists
       (select 1 from public.customers c where c.id = p_customer_id and c.tenant_id = v_tenant) then
    raise exception 'Customer is not in the caller''s company' using errcode = '42501';
  end if;

  for v_li in select * from jsonb_array_elements(coalesce(p_line_items, '[]'::jsonb)) loop
    v_taxable := v_taxable + greatest(coalesce((v_li->>'amount')::integer, 0), 0);
  end loop;
  if v_taxable <= 0 then raise exception 'Quotation needs at least one line item'; end if;

  v_gst   := round(v_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := v_taxable + v_gst;

  insert into public.project_sales
    (tenant_id, customer_id, customer_name, title, description, gst_rate, inter_state,
     taxable_amount, gst_amount, total_amount, status, line_items)
  values
    (v_tenant, p_customer_id, p_customer_name, p_title, nullif(trim(coalesce(p_description,'')),''),
     coalesce(p_gst_rate, 18), coalesce(p_inter_state, false),
     v_taxable, v_gst, v_total, 'quoted', coalesce(p_line_items, '[]'::jsonb))
  returning id into v_id;

  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb)) loop
    v_seq := v_seq + 1;
    insert into public.project_milestones (tenant_id, project_id, seq, label, total_amount, due_date)
    values (
      v_tenant, v_id, v_seq,
      coalesce(v_m->>'label', 'Milestone ' || v_seq),
      greatest(coalesce((v_m->>'total_amount')::integer, 0), 0),
      nullif(v_m->>'due_date','')::date
    );
  end loop;

  return v_id;
end;
$function$;

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
  /* R-1819 (security audit 24 Oct 2026): accepting turns the quotation into an active project
     that can be invoiced — the money roles only (sales raise the quotation; the customer accepts
     through the public link, which is service_role and trusted). */
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can mark a project quotation accepted' using errcode = '42501';
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
      values (v_tenant, trim(v_name), public.ist_today(), 70)
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

create or replace function public.cancel_subscription(
  p_subscription_id uuid,
  p_last_day        date,
  p_reason          text,
  p_clear_due       boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-455 + R-1711: end a subscription; a due an open GST invoice asks for is never cleared here. */
declare
  v_tenant    uuid := public.current_tenant_id();
  v_sub       record;
  v_last      date := coalesce(p_last_day, (now() at time zone 'Asia/Kolkata')::date);
  v_end       date;
  v_cleared   integer := 0;
  v_owed      integer;
  v_inv_due   integer := 0;
  v_inv_ids   text[]  := '{}';
  v_kept      integer := 0;
  v_r1819_trusted boolean;
begin
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Write why the subscription is ending (at least 5 characters) — it is kept on the record.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'Subscription not found — refresh the page; it may have been deleted.';
  end if;
  /* R-1819 (security audit 24 Oct 2026): §17c — trusted is named, everyone else needs a company
     and the role. Was: the checks ran only for a request role of anon/authenticated, so a session
     with no request role from the app's own login skipped both. */
  v_r1819_trusted := coalesce(auth.role(), '') = 'service_role'
                     or (auth.role() is null
                         and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null and not v_r1819_trusted then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if (v_tenant is not null or not v_r1819_trusted) and v_sub.tenant_id is distinct from v_tenant then
    raise exception 'Subscription not in your workspace' using errcode = 'insufficient_privilege';
  end if;
  if not v_r1819_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can cancel a subscription — it takes it out of MRR and renewals. Ask one of them (Subscriptions → the subscription → Cancel subscription).'
      using errcode = 'insufficient_privilege';
  end if;
  if v_sub.status = 'cancelled' then
    raise exception 'This subscription is already cancelled. To bring it back, use Correct details → Status.'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_sub.start_date is not null and v_last < v_sub.start_date then
    raise exception 'The last day (%) is before the subscription started (%). Pick a date on or after the start.', v_last, v_sub.start_date
      using errcode = 'invalid_parameter_value';
  end if;

  v_owed := greatest(0, coalesce(v_sub.outstanding_amount, 0));
  if p_clear_due and v_owed > 0 then
    /* R-1711: what this subscription's OPEN invoices still ask for (write_off_subscription's match). */
    select coalesce(sum(greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0))), 0)::integer,
           coalesce(array_agg(i.id order by i.id), '{}')
      into v_inv_due, v_inv_ids
      from public.invoices i
     where i.tenant_id = v_sub.tenant_id
       and i.status::text in ('pending', 'overdue')
       and i.written_off_at is null
       and greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) > 0
       and (   (v_sub.quote_id is not null and i.quote_id = v_sub.quote_id)
            or (v_sub.renewal_quote_id is not null and i.quote_id = v_sub.renewal_quote_id)
            or exists (select 1 from public.subscription_billings b
                        where b.subscription_id = v_sub.id and b.tenant_id = v_sub.tenant_id and b.invoice_id = i.id));

    v_kept    := least(v_owed, v_inv_due);
    v_cleared := v_owed - v_kept;
    if v_cleared = 0 then
      raise exception 'The % still due is on open invoice % — clearing it here would leave that GST invoice asking for money the subscription says is not owed. Issue a credit note for the unused part on the invoice first (CGST s.34), then cancel; or cancel without clearing if the customer still has to pay.',
        '₹' || to_char(v_owed, 'FM99,99,99,999'), array_to_string(v_inv_ids, ', ')
        using errcode = 'invalid_parameter_value';
    end if;
  end if;
  v_end := case when v_sub.renewal_date is null or v_last < v_sub.renewal_date then v_last else v_sub.renewal_date end;

  update public.subscriptions
     set status             = 'cancelled',
         auto_renew         = false,
         renewal_date       = v_end,
         outstanding_amount = case when v_cleared > 0 then outstanding_amount - v_cleared else outstanding_amount end,
         cancelled_at       = now(),
         cancel_reason      = left(trim(p_reason), 500),
         cancel_due_cleared = v_cleared
   where id = p_subscription_id;

  return jsonb_build_object(
    'subscription_id', p_subscription_id,
    'status',          'cancelled',
    'last_day',        v_end,
    'due_cleared',     v_cleared,
    'due_kept',        v_kept,
    'open_invoices',   to_jsonb(case when v_kept > 0 then v_inv_ids else '{}'::text[] end)
  );
end $$;

commit;
