-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.redeem_coupon(text,uuid,text,integer,integer,text,text,text,text)') and prosrc like '%R-715%' and not has_function_privilege('authenticated', oid, 'execute')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.create_project_quote(uuid,text,text,text,jsonb,integer,boolean,jsonb)') and prosrc like '%R-715%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.get_subordinate_user_ids(uuid)') and prosrc like '%R-715%') and exists(select 1 from pg_proc where oid = to_regprocedure('public._employee_advance_cash_leg(uuid,uuid,date,integer,integer,text,uuid)') and not has_function_privilege('authenticated', oid, 'execute'))
-- deploy-key: r715definers
--
-- R-715 (P1 SECURITY, audit 10 Oct 2026): the remaining SECURITY DEFINER functions that take
-- a tenant / record id and did not check it against the caller. Re-checked 11 Oct on the
-- newest definitions — none had been fixed by a later migration. Every hole below was proved
-- on the local DB (supabase/tests/r715_definers_tenant.test.sql fails on the old bodies).
--
-- A. SERVER-ONLY → EXECUTE revoked from authenticated / anon / public (and the staging
--    app_runtime / app_anon roles if present). Nothing in src/ calls them through a user
--    client; their only callers are the admin client or other SECURITY DEFINER functions
--    (which run as the owner, so they keep working):
--      redeem_coupon            ← checkout route (admin client). Also: guard (own company
--                                 only unless trusted) + the redemption_count UPDATE now
--                                 filters tenant_id too, not just code.
--                                 Before: anyone signed in could probe / burn any company's
--                                 coupon codes.
--      _employee_advance_cash_leg ← give/top_up/settle_employee_advance (definers).
--                                 Before: an entry in another company's cash book.
--      quote_split_due, split_outstanding_for ← sync_split_outstanding + subscriptions trigger.
--                                 Before: another company's instalment / outstanding figures.
--      invoice_party_snapshot   ← invoice trigger, generate_invoice, raise_subscription_billing.
--                                 Before: another company's customer GSTIN + address.
--      payment_run_outstanding  ← create/approve/mark_paid payment run (definers).
--      get_active_site_promo    ← no caller at all (site promos are read from the table).
-- B. GUARDED (still called by signed-in users), same trust rule as R-454 / R-714:
--    trusted = auth.role() = 'service_role' or a direct DB session with no request role.
--      suggest_bank_transaction_matches  no company → 42501; another company's bank line →
--                                 nothing (as if not found). Before: their payments /
--                                 expenses / salaries.
--      sync_split_outstanding   no company → 42501 (before: passed the guard).
--      create_project_quote / create_project_sale  p_customer_id must be the caller's
--                                 company's customer (42501). create_project_direct_invoice
--                                 goes through create_project_quote, so it is covered too.
--      get_subordinate_user_ids  the anchor user must be in the caller's company, else empty.
--                                 (RLS calls it with auth.uid(), so visibility is unchanged.)
-- Bodies are the newest definitions (baseline / 20261009235800 / 20260818150000) with ONLY
-- the guard lines added. No money maths changed. Signatures unchanged, grants kept except
-- the revokes in A.
-- Staging: the deploy script rewrites auth.role() -> public.current_request_role() (R-161).
-- Test: supabase/tests/r715_definers_tenant.test.sql (rolled back).

begin;

CREATE OR REPLACE FUNCTION public.redeem_coupon(p_code text, p_tenant_id uuid, p_tier_id text, p_seats integer, p_gross_amount integer, p_quote_id text DEFAULT NULL::text, p_lead_id text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_coupon       record;
  v_discount     integer;
  v_now          timestamptz := now();
  v_caller       uuid;
begin
  /* R-715: server-only (checkout uses the admin client). EXECUTE is revoked from signed-in
     roles below; this guard keeps it safe even if a grant ever comes back: an untrusted caller
     may only redeem in their own company. */
  if not (coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'))) then
    v_caller := public.current_tenant_id();
    if v_caller is null or p_tenant_id is distinct from v_caller then
      raise exception 'Coupons can only be redeemed for the caller''s own company' using errcode = '42501';
    end if;
  end if;

  select * into v_coupon
  from public.coupons
  where code = upper(trim(p_code)) and tenant_id = p_tenant_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;

  if not v_coupon.is_active then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;
  if v_coupon.valid_from > v_now then
    return jsonb_build_object('ok', false, 'reason', 'not_started');
  end if;
  if v_coupon.valid_until is not null and v_coupon.valid_until < v_now then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_coupon.max_redemptions is not null
     and v_coupon.redemption_count >= v_coupon.max_redemptions then
    return jsonb_build_object('ok', false, 'reason', 'maxed_out');
  end if;
  if v_coupon.applies_to_tier is not null
     and lower(v_coupon.applies_to_tier) <> lower(coalesce(p_tier_id, '')) then
    return jsonb_build_object('ok', false, 'reason', 'wrong_tier',
      'required_tier', v_coupon.applies_to_tier);
  end if;
  if p_seats < v_coupon.min_seats then
    return jsonb_build_object('ok', false, 'reason', 'min_seats_not_met',
      'min_seats', v_coupon.min_seats);
  end if;
  if v_coupon.max_seats is not null and p_seats > v_coupon.max_seats then
    return jsonb_build_object('ok', false, 'reason', 'max_seats_exceeded',
      'max_seats', v_coupon.max_seats);
  end if;

  if v_coupon.discount_type = 'percent' then
    v_discount := round(p_gross_amount * v_coupon.discount_value / 100.0);
  else
    v_discount := v_coupon.discount_value;
  end if;
  v_discount := least(v_discount, p_gross_amount);

  insert into public.coupon_redemptions (
    coupon_code, tenant_id, quote_id, lead_id, contact_email, contact_name,
    tier_id, seats, amount_saved
  ) values (
    v_coupon.code, p_tenant_id, p_quote_id, p_lead_id, p_email, p_name,
    p_tier_id, p_seats, v_discount
  );

  update public.coupons
    set redemption_count = redemption_count + 1
    where code = v_coupon.code
      and tenant_id = p_tenant_id;   -- R-715: only this company's coupon

  return jsonb_build_object(
    'ok',             true,
    'discount',       v_discount,
    'discount_type',  v_coupon.discount_type,
    'discount_value', v_coupon.discount_value,
    'code',           v_coupon.code
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.suggest_bank_transaction_matches(p_bank_txn_id uuid)
 RETURNS TABLE(match_type text, match_id text, match_label text, match_amount integer, match_date date, match_confidence text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_txn record; v_tenant uuid; v_search_amount integer; v_is_credit boolean;
  v_caller uuid; v_trusted boolean;
begin
  /* R-715: a signed-in caller sees suggestions only for their own company's bank line.
     No company (null-caller) → refused; another company's line → nothing (as "not found"). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '42501';
  end if;
  select bt.* into v_txn from public.bank_transactions bt where bt.id = p_bank_txn_id;
  if not found then return; end if;
  if not v_trusted and v_txn.tenant_id is distinct from v_caller then return; end if;
  v_tenant := v_txn.tenant_id; v_search_amount := greatest(v_txn.debit, v_txn.credit); v_is_credit := v_txn.credit > 0;
  if v_is_credit then
    return query
    select 'payment'::text, p.id::text,
           coalesce(c.name, p.receipt_voucher_no, 'Payment') || case when p.reference is not null and p.reference <> '' then ' · ' || p.reference else '' end,
           p.amount, p.received_at::date,
           case when p.amount = v_search_amount and p.received_at::date = v_txn.txn_date then 'exact'
                when p.amount = v_search_amount and abs(p.received_at::date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.payments p left join public.customers c on c.id = p.customer_id
    where p.tenant_id = v_tenant and p.status = 'received' and abs(p.amount - v_search_amount) <= 100 and abs(p.received_at::date - v_txn.txn_date) <= 7
    order by abs(p.amount - v_search_amount), abs(p.received_at::date - v_txn.txn_date) limit 5;

    return query
    select 'project'::text, pp.id::text,
           coalesce(ps.customer_name, ps.title, 'Project payment') || ' · project',
           pp.amount, pp.received_at::date,
           case when pp.amount = v_search_amount and pp.received_at::date = v_txn.txn_date then 'exact'
                when pp.amount = v_search_amount and abs(pp.received_at::date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.project_payments pp
    join public.project_sales ps on ps.id = pp.project_id
    where pp.tenant_id = v_tenant and pp.bank_txn_id is null
      and abs(pp.amount - v_search_amount) <= 100 and abs(pp.received_at::date - v_txn.txn_date) <= 7
    order by abs(pp.amount - v_search_amount), abs(pp.received_at::date - v_txn.txn_date) limit 5;
  end if;
  if not v_is_credit then
    return query
    select 'salary'::text, sp.id::text, e.name || ' · salary ' || sp.period, sp.net, sp.pay_date,
           case when sp.net = v_search_amount and sp.pay_date = v_txn.txn_date then 'exact'
                when sp.net = v_search_amount and abs(sp.pay_date - v_txn.txn_date) <= 10 then 'high' else 'low' end::text
    from public.salary_payments sp join public.employees e on e.id = sp.employee_id
    where sp.tenant_id = v_tenant and sp.paid_status = 'unpaid' and abs(sp.net - v_search_amount) <= 100 and abs(sp.pay_date - v_txn.txn_date) <= 15
    order by abs(sp.net - v_search_amount), abs(sp.pay_date - v_txn.txn_date) limit 5;
    return query
    select 'expense'::text, e.id::text, coalesce(e.vendor_name, e.category, 'Expense'), e.amount, e.expense_date,
           case when e.amount = v_search_amount and e.expense_date = v_txn.txn_date then 'exact'
                when e.amount = v_search_amount and abs(e.expense_date - v_txn.txn_date) <= 3 then 'high' else 'low' end::text
    from public.expenses e
    where e.tenant_id = v_tenant and e.category <> 'Salaries' and abs(e.amount - v_search_amount) <= 100 and abs(e.expense_date - v_txn.txn_date) <= 7
    order by abs(e.amount - v_search_amount), abs(e.expense_date - v_txn.txn_date) limit 5;
  end if;
end; $function$;

CREATE OR REPLACE FUNCTION public.sync_split_outstanding(p_subscription_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sub   record;
  v_first uuid;
  v_owed  integer;
  v_caller  uuid;
  v_trusted boolean;
begin
  /* R-715: same trust rule as R-454 — a signed-in login with no company is refused. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '42501';
  end if;
  select s.id, s.tenant_id, s.quote_id, s.start_date, s.status, s.written_off_at, s.outstanding_amount
    into v_sub
    from public.subscriptions s where s.id = p_subscription_id
   for update;
  if not found then return null; end if;
  if not v_trusted and v_sub.tenant_id is distinct from v_caller then
    raise exception 'subscription % is not in the caller''s tenant', p_subscription_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_sub.quote_id is null or v_sub.status <> 'active' or v_sub.written_off_at is not null then
    return null;
  end if;
  select s.id into v_first from public.subscriptions s
   where s.tenant_id = v_sub.tenant_id and s.quote_id = v_sub.quote_id
   order by s.created_at, s.id limit 1;
  if v_first is distinct from v_sub.id then return null; end if;

  v_owed := public.split_outstanding_for(v_sub.quote_id, v_sub.start_date);
  if v_owed is null then return null; end if;
  if v_owed is distinct from coalesce(v_sub.outstanding_amount, 0) then
    -- a raise is a plain write; the trigger only acts on a positive new value and
    -- caps it at the same figure, so this lands as computed
    update public.subscriptions set outstanding_amount = v_owed where id = v_sub.id;
  end if;
  return v_owed;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_project_quote(p_customer_id uuid, p_customer_name text, p_title text, p_description text, p_line_items jsonb, p_gst_rate integer, p_inter_state boolean, p_milestones jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_taxable integer := 0;
  v_gst     integer;
  v_total   integer;
  v_id      uuid;
  v_li      jsonb;
  v_m       jsonb;
  v_seq     integer := 0;
begin
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

CREATE OR REPLACE FUNCTION public.create_project_sale(p_customer_id uuid, p_customer_name text, p_title text, p_description text, p_taxable integer, p_gst_rate integer, p_inter_state boolean, p_milestones jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_gst    integer;
  v_total  integer;
  v_id     uuid;
  v_cust   uuid := p_customer_id;
  v_m      jsonb;
  v_seq    integer := 0;
begin
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  -- R-715: the customer must belong to the caller's company.
  if p_customer_id is not null and not exists
       (select 1 from public.customers c where c.id = p_customer_id and c.tenant_id = v_tenant) then
    raise exception 'Customer is not in the caller''s company' using errcode = '42501';
  end if;
  if coalesce(p_taxable, 0) <= 0 then raise exception 'Taxable amount must be > 0'; end if;

  if v_cust is null and length(trim(coalesce(p_customer_name, ''))) > 0 then
    select id into v_cust from public.customers
     where tenant_id = v_tenant and lower(name) = lower(trim(p_customer_name)) limit 1;
    if v_cust is null then
      insert into public.customers (tenant_id, name, since, health)
      values (v_tenant, trim(p_customer_name), current_date, 70)
      returning id into v_cust;
    end if;
  end if;

  v_gst   := round(p_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := p_taxable + v_gst;

  insert into public.project_sales
    (tenant_id, customer_id, customer_name, title, description, gst_rate, inter_state,
     taxable_amount, gst_amount, total_amount)
  values
    (v_tenant, v_cust, p_customer_name, p_title, nullif(trim(coalesce(p_description,'')),''),
     coalesce(p_gst_rate, 18), coalesce(p_inter_state, false), p_taxable, v_gst, v_total)
  returning id into v_id;

  for v_m in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb))
  loop
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

CREATE OR REPLACE FUNCTION public.get_subordinate_user_ids(p_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with recursive tree as (
    select u.id, u.tenant_id
    from public.users u
    where u.id = p_user_id
      -- R-715: a signed-in caller may only walk a tree inside their own company
      and (coalesce(auth.role(), '') = 'service_role'
                   or (auth.role() is null
                       and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'))
           or u.tenant_id = public.current_tenant_id())
    union
    select c.id, c.tenant_id
    from public.users c
    join tree t on c.manager_id = t.id
    where c.tenant_id = t.tenant_id
  )
  select id from tree;
$function$;

-- ── A. server-only functions ───────────────────────────────────────────────────
revoke execute on function public.redeem_coupon(text, uuid, text, integer, integer, text, text, text, text) from public, anon, authenticated;
revoke execute on function public._employee_advance_cash_leg(uuid, uuid, date, integer, integer, text, uuid) from public, anon, authenticated;
revoke execute on function public.quote_split_due(text, date, date) from public, anon, authenticated;
revoke execute on function public.split_outstanding_for(text, date) from public, anon, authenticated;
revoke execute on function public.invoice_party_snapshot(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.payment_run_outstanding(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.get_active_site_promo(uuid, text, integer) from public, anon, authenticated;

grant execute on function public.redeem_coupon(text, uuid, text, integer, integer, text, text, text, text) to service_role;
grant execute on function public._employee_advance_cash_leg(uuid, uuid, date, integer, integer, text, uuid) to service_role;
grant execute on function public.quote_split_due(text, date, date) to service_role;
grant execute on function public.split_outstanding_for(text, date) to service_role;
grant execute on function public.invoice_party_snapshot(uuid, uuid) to service_role;
grant execute on function public.payment_run_outstanding(uuid, text, text) to service_role;
grant execute on function public.get_active_site_promo(uuid, text, integer) to service_role;

-- Staging (R-161) signed-in roles, if this database has them.
do $$
declare r text;
begin
  foreach r in array array['app_runtime', 'app_anon'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function public.redeem_coupon(text, uuid, text, integer, integer, text, text, text, text) from %I', r);
      execute format('revoke execute on function public._employee_advance_cash_leg(uuid, uuid, date, integer, integer, text, uuid) from %I', r);
      execute format('revoke execute on function public.quote_split_due(text, date, date) from %I', r);
      execute format('revoke execute on function public.split_outstanding_for(text, date) from %I', r);
      execute format('revoke execute on function public.invoice_party_snapshot(uuid, uuid) from %I', r);
      execute format('revoke execute on function public.payment_run_outstanding(uuid, text, text) from %I', r);
      execute format('revoke execute on function public.get_active_site_promo(uuid, text, integer) from %I', r);
    end if;
  end loop;
end $$;

commit;
