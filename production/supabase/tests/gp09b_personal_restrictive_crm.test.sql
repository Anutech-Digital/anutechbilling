-- R-2123 (GP-09b, goal G-PERSONAL) — the DB wall, part 2.
-- Migration: 20261030104442_gp09b_personal_restrictive_crm.sql (needs gp09a, R-2122).
--
-- A personal session (users.role = 'personal', OR any login of a tenant whose
-- workspace_kind = 'personal') must not read or write the CRM, team, vendor/purchase,
-- catalogue, automation, customer-message and spend tables either.
--
-- THE CASES (each FAILS LOUDLY — the file is self-asserting)
--   1. Coverage: every table on the gp09b list has the wrapped gp09_ RESTRICTIVE FOR ALL policy.
--   2. Kind branch: an OWNER of a personal-kind tenant (passes every owner-only permissive
--      policy) reads 0 rows from EVERY listed table — its seeded leads / team_invites / items /
--      vendors / expenses / purchase_orders / statutory dues included — and its inserts into
--      leads, team_invites, items and vendors are refused.                   <- red on old code
--   3. Role branch: a role-'personal' login inside a BUSINESS tenant — the same.  <- red on old code
--   4. The pure personal user (role personal, personal tenant) — the same.
--   5. A business owner is unchanged: reads the seeded rows, inserts a lead, an item and an
--      invite, updates an expense.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/gp09b_personal_restrictive_crm.test.sql

begin;

create temp table gp09b_list (t text primary key) on commit drop;
insert into gp09b_list (t) values
  ('leads'), ('lead_activities'), ('lead_finder_profiles'), ('lead_finder_runs'),
  ('lead_finder_candidates'), ('indiamart_lead_imports'), ('contacts'), ('customer_contacts'),
  ('cold_call_campaigns'), ('cold_call_contacts'), ('payment_followups'),
  ('team_invites'), ('join_requests'),
  ('vendors'), ('vendor_bills'), ('vendor_advance_applications'), ('vendor_narration_aliases'),
  ('purchase_orders'), ('po_bill_allocations'), ('inbound_purchases'),
  ('items'), ('packages'), ('package_items'),
  ('automation_jobs'), ('automation_job_runs'),
  ('whatsapp_messages'), ('whatsapp_broadcasts'), ('whatsapp_templates'),
  ('whatsapp_reminder_settings'), ('whatsapp_reminder_templates'), ('whatsapp_reminder_log'),
  ('whatsapp_opt_outs'), ('customer_email_sends'), ('campaigns'), ('campaign_sends'),
  ('campaign_templates'), ('renewal_email_log'),
  ('expenses'), ('expense_claims'), ('project_payments'), ('payment_runs'), ('payment_run_items'),
  ('bank_vendor_payment_lines'), ('late_charge_bills'), ('emi_purchases'), ('emi_payments'),
  ('emi_schedule'), ('business_loans'), ('business_loan_payments'), ('loans_given'),
  ('loan_repayments'), ('employee_loans'), ('employee_loan_repayments'),
  ('statutory_dues_payments'), ('salary_payments');
grant select on gp09b_list to authenticated;

-- ── 1. coverage ─────────────────────────────────────────────────────────────────────
do $$
declare v_missing text;
begin
  if to_regprocedure('public.is_personal_session()') is null then
    raise exception 'FAIL 1: public.is_personal_session() does not exist — gp09a (R-2122) not applied';
  end if;
  select string_agg(l.t, ', ' order by l.t) into v_missing
    from gp09b_list l
   where not exists (
     select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = l.t
        and p.policyname like 'gp09\_%' and p.permissive = 'RESTRICTIVE' and p.cmd = 'ALL'
        and 'authenticated' = any (p.roles)
        and p.qual ilike '%( SELECT is_personal_session()%'
        and p.with_check ilike '%is_personal_session%');
  if v_missing is not null then
    raise exception 'FAIL 1: no wrapped gp09_ RESTRICTIVE FOR ALL policy on: %', v_missing;
  end if;
end $$;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('c2123000-0000-0000-0000-0000000000a1', 'gp09b-owner@example.test'),
  ('c2123000-0000-0000-0000-0000000000a2', 'gp09b-personal@example.test'),
  ('c2123000-0000-0000-0000-0000000000a3', 'gp09b-kind-owner@example.test'),
  ('c2123000-0000-0000-0000-0000000000a4', 'gp09b-role-personal@example.test');

-- superuser here, so the R-720 guard lets the fixture set workspace_kind.
insert into public.tenants (id, name, email, state_code, doc_code, workspace_kind) values
  ('c2123000-0000-0000-0000-0000000000f1', 'GP09B BIZ', 'gp09b-biz@example.test', '07', 'G9BB', 'business'),
  ('c2123000-0000-0000-0000-0000000000f2', 'GP09B ME',  'gp09b-me@example.test',  '07', 'G9BP', 'personal');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2123000-0000-0000-0000-0000000000a1', 'c2123000-0000-0000-0000-0000000000f1', 'gp09b-owner@example.test',         'Biz Owner',     'owner',    true),
  ('c2123000-0000-0000-0000-0000000000a2', 'c2123000-0000-0000-0000-0000000000f2', 'gp09b-personal@example.test',      'Personal User', 'personal', true),
  -- kind branch: role owner, but the tenant is personal
  ('c2123000-0000-0000-0000-0000000000a3', 'c2123000-0000-0000-0000-0000000000f2', 'gp09b-kind-owner@example.test',    'Kind Owner',    'owner',    true),
  -- role branch: role personal, but the tenant is business
  ('c2123000-0000-0000-0000-0000000000a4', 'c2123000-0000-0000-0000-0000000000f1', 'gp09b-role-personal@example.test', 'Role Personal', 'personal', true);

-- seeded rows in BOTH tenants (what any login of that tenant would see on old code)
insert into public.leads (id, tenant_id, company) values
  ('GP09B-L-B', 'c2123000-0000-0000-0000-0000000000f1', 'GP09B Lead B'),
  ('GP09B-L-P', 'c2123000-0000-0000-0000-0000000000f2', 'GP09B Lead P');
insert into public.team_invites (tenant_id, email) values
  ('c2123000-0000-0000-0000-0000000000f1', 'gp09b-inv-b@example.test'),
  ('c2123000-0000-0000-0000-0000000000f2', 'gp09b-inv-p@example.test');
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale) values
  ('GP09B-IT-B', 'c2123000-0000-0000-0000-0000000000f1', 'GP09B Item B', 'other', 1000, 800),
  ('GP09B-IT-P', 'c2123000-0000-0000-0000-0000000000f2', 'GP09B Item P', 'other', 1000, 800);
insert into public.vendors (tenant_id, name) values
  ('c2123000-0000-0000-0000-0000000000f1', 'GP09B Vendor B'),
  ('c2123000-0000-0000-0000-0000000000f2', 'GP09B Vendor P');
insert into public.expenses (id, tenant_id, category, expense_date, amount) values
  ('GP09B-EX-B', 'c2123000-0000-0000-0000-0000000000f1', 'office', current_date, 500),
  ('GP09B-EX-P', 'c2123000-0000-0000-0000-0000000000f2', 'office', current_date, 500);
insert into public.purchase_orders (id, tenant_id, customer_name, vendor, plan, seats) values
  ('GP09B-PO-B', 'c2123000-0000-0000-0000-0000000000f1', 'GP09B Cust', 'other', 'basic', 1),
  ('GP09B-PO-P', 'c2123000-0000-0000-0000-0000000000f2', 'GP09B Cust', 'other', 'basic', 1);
insert into public.statutory_dues_payments (tenant_id, amount, paid_on) values
  ('c2123000-0000-0000-0000-0000000000f1', 700, current_date),
  ('c2123000-0000-0000-0000-0000000000f2', 700, current_date);

set local role authenticated;

do $$
declare
  v_owner  uuid := 'c2123000-0000-0000-0000-0000000000a1';
  v_pers   uuid := 'c2123000-0000-0000-0000-0000000000a2';
  v_kindow uuid := 'c2123000-0000-0000-0000-0000000000a3';
  v_rolep  uuid := 'c2123000-0000-0000-0000-0000000000a4';
  v_biz    uuid := 'c2123000-0000-0000-0000-0000000000f1';
  v_me     uuid := 'c2123000-0000-0000-0000-0000000000f2';
  n        bigint;
  v_who    uuid;
  v_ten    uuid;
  v_label  text;
  v_t      text;
  v_seen   text;
  v_blocked boolean;
begin
  ------------------------------------------- 2 + 3 + 4. personal sessions: nothing
  foreach v_who in array array[v_kindow, v_rolep, v_pers] loop
    v_ten := case when v_who = v_rolep then v_biz else v_me end;
    v_label := case v_who when v_kindow then 'owner of a PERSONAL tenant'
                          when v_pers   then 'personal user'
                          else 'role-personal login in a BUSINESS tenant' end;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_who::text, 'role', 'authenticated')::text, true);
    if auth.uid() <> v_who then
      raise exception 'SETUP FAIL: impersonation of % did not take', v_label;
    end if;

    -- every listed table reads 0 rows
    v_seen := null;
    for v_t in select t from gp09b_list order by t loop
      execute format('select count(*) from public.%I', v_t) into n;
      if n <> 0 then
        v_seen := coalesce(v_seen || ', ', '') || v_t || '=' || n;
      end if;
    end loop;
    if v_seen is not null then
      raise exception 'FAIL 2: the % reads rows from: %', v_label, v_seen;
    end if;

    begin
      insert into public.leads (id, tenant_id, company)
        values ('GP09B-L-X-' || right(v_who::text, 2), v_ten, 'planted');
      v_blocked := false;
    exception when insufficient_privilege then v_blocked := true;
    end;
    if not v_blocked then raise exception 'FAIL 2: the % inserted a lead', v_label; end if;

    begin
      insert into public.team_invites (tenant_id, email, role)
        values (v_ten, 'gp09b-planted-' || right(v_who::text, 2) || '@example.test', 'sales');
      v_blocked := false;
    exception when insufficient_privilege then v_blocked := true;
    end;
    if not v_blocked then raise exception 'FAIL 2: the % inserted a team invite', v_label; end if;

    begin
      insert into public.items (id, tenant_id, name, vendor, msrp, wholesale)
        values ('GP09B-IT-X-' || right(v_who::text, 2), v_ten, 'planted', 'other', 1, 1);
      v_blocked := false;
    exception when insufficient_privilege then v_blocked := true;
    end;
    if not v_blocked then raise exception 'FAIL 2: the % inserted an item', v_label; end if;

    begin
      insert into public.vendors (tenant_id, name) values (v_ten, 'GP09B planted vendor');
      v_blocked := false;
    exception when insufficient_privilege then v_blocked := true;
    end;
    if not v_blocked then raise exception 'FAIL 2: the % inserted a vendor', v_label; end if;

    update public.expenses set amount = 1 where id in ('GP09B-EX-B', 'GP09B-EX-P');
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL 2: the % updated % expense(s)', v_label, n; end if;
  end loop;

  ---------------------------------------------------- 5. a business owner is unchanged
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);
  if public.is_personal_session() then
    raise exception 'FAIL 5: is_personal_session() is true for a business owner';
  end if;
  select count(*) into n from public.leads where id = 'GP09B-L-B';
  if n <> 1 then raise exception 'FAIL 5: the business owner reads % seeded lead(s), expected 1', n; end if;
  select count(*) into n from public.team_invites where tenant_id = v_biz;
  if n <> 1 then raise exception 'FAIL 5: the business owner reads % invite(s), expected 1', n; end if;
  select count(*) into n from public.items where id = 'GP09B-IT-B';
  if n <> 1 then raise exception 'FAIL 5: the business owner reads % item(s), expected 1', n; end if;
  select count(*) into n from public.vendors where tenant_id = v_biz;
  if n <> 1 then raise exception 'FAIL 5: the business owner reads % vendor(s), expected 1', n; end if;
  select count(*) into n from public.expenses where id = 'GP09B-EX-B';
  if n <> 1 then raise exception 'FAIL 5: the business owner reads % expense(s), expected 1', n; end if;
  select count(*) into n from public.purchase_orders where id = 'GP09B-PO-B';
  if n <> 1 then raise exception 'FAIL 5: the business owner reads % purchase order(s), expected 1', n; end if;
  select count(*) into n from public.statutory_dues_payments where tenant_id = v_biz;
  if n <> 1 then raise exception 'FAIL 5: the business owner reads % statutory payment(s), expected 1', n; end if;

  insert into public.leads (id, tenant_id, company) values ('GP09B-L-OWNER', v_biz, 'GP09B owner lead');
  insert into public.items (id, tenant_id, name, vendor, msrp, wholesale)
    values ('GP09B-IT-OWNER', v_biz, 'GP09B owner item', 'other', 1000, 800);
  insert into public.team_invites (tenant_id, email, role) values (v_biz, 'gp09b-owner-invite@example.test', 'sales');
  update public.expenses set amount = 600 where id = 'GP09B-EX-B';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 5: the business owner updated % expense(s), expected 1', n; end if;
end $$;

do $$ begin raise notice 'gp09b_personal_restrictive_crm: all checks passed'; end $$;

rollback;
