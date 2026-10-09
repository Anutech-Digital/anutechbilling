-- deploy-peek: (to_regclass('public.late_charge_bills') is not null and to_regprocedure('public.bill_late_charges(text,integer,integer,date,date)') is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name='tenants' and column_name='late_fee_enabled'))
-- deploy-key: latecharges
-- 20261009233000_late_payment_charges.sql
--
-- R-530 (Pardeep, 9 Oct 2026) — late payment charges: a flat late fee (default Rs 500, once)
-- plus simple interest (default 18% p.a.) on overdue invoices.
--
--   1. tenants.late_fee_* — the company setting. OFF by default. Interest only for
--      GST-registered customers by default (7 Oct rule); unregistered ones get the flat fee only.
--   2. late_fee_overrides — Default / On / Off for a customer, a subscription or an invoice.
--      The most specific level that is not "default" wins (invoice > subscription > customer >
--      company). A waiver is an invoice-level Off with a reason.
--   3. late_fee_audit — every settings change, toggle, waiver and bill: who, when, before/after.
--   4. late_charge_bills + bill_late_charges() — the owner's "Bill late charges" click. It
--      raises a DEBIT NOTE on the late invoice through the existing issue_debit_note (CGST s.34;
--      late fee / interest are part of the value of supply under s.15(2)(d) — CA to confirm),
--      taxed at the invoice's OWN tax_rate. The issued invoice's lines and amount never change.
--      No GST rate on the invoice -> refused; a rate is never assumed.
--
-- The amounts are worked out by lib/late-charges/charges.ts (pure, unit-tested); this file
-- re-checks what can be checked: role, level precedence, waiver, the fee only once, the fee
-- not above the company's figure, and the GST rate.
-- Test: supabase/tests/late_payment_charges.test.sql (begin ... rollback).

begin;

-- ── 1. Company setting ───────────────────────────────────────────────────────
alter table public.tenants
  add column if not exists late_fee_enabled boolean not null default false,
  add column if not exists late_fee_enabled_at timestamptz,
  add column if not exists late_interest_pct numeric(5,2) not null default 18,
  add column if not exists late_fee_flat integer not null default 500,
  add column if not exists late_fee_grace_days integer not null default 0,
  add column if not exists late_interest_registered_only boolean not null default true;

alter table public.tenants drop constraint if exists tenants_late_interest_pct_range;
alter table public.tenants add constraint tenants_late_interest_pct_range check (late_interest_pct between 0 and 36);
alter table public.tenants drop constraint if exists tenants_late_fee_flat_range;
alter table public.tenants add constraint tenants_late_fee_flat_range check (late_fee_flat between 0 and 100000);
alter table public.tenants drop constraint if exists tenants_late_fee_grace_range;
alter table public.tenants add constraint tenants_late_fee_grace_range check (late_fee_grace_days between 0 and 90);

comment on column public.tenants.late_fee_enabled is
  'R-530: company default for late payment charges (customer/subscription/invoice can override). Default off.';
comment on column public.tenants.late_fee_enabled_at is
  'R-530: when the company switch was last turned on. Charges count only from this day.';

commit;

begin;

-- ── 2. Per customer / subscription / invoice override ────────────────────────
create table if not exists public.late_fee_overrides (
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  entity_type  text not null check (entity_type in ('customer', 'subscription', 'invoice')),
  entity_id    text not null,
  mode         text not null check (mode in ('on', 'off')),
  waived       boolean not null default false,
  waive_reason text,
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, entity_type, entity_id),
  check (not waived or (entity_type = 'invoice' and mode = 'off' and length(btrim(coalesce(waive_reason, ''))) >= 3))
);
comment on table public.late_fee_overrides is
  'R-530: On/Off for late charges on one customer, subscription or invoice. No row = Default (take the level above). Written only through set_late_fee_mode / waive_late_charges.';

alter table public.late_fee_overrides enable row level security;
revoke all on table public.late_fee_overrides from anon;
grant select on table public.late_fee_overrides to authenticated;
grant all on table public.late_fee_overrides to service_role;
drop policy if exists late_fee_overrides_select on public.late_fee_overrides;
create policy late_fee_overrides_select on public.late_fee_overrides
  for select to authenticated using (tenant_id = (select public.current_tenant_id()));
drop policy if exists late_fee_overrides_service_role on public.late_fee_overrides;
create policy late_fee_overrides_service_role on public.late_fee_overrides
  to service_role using (true) with check (true);

-- ── 3. Audit ─────────────────────────────────────────────────────────────────
create table if not exists public.late_fee_audit (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  entity_type text not null check (entity_type in ('company', 'customer', 'subscription', 'invoice')),
  entity_id   text not null,
  action      text not null check (action in ('settings', 'mode', 'waived', 'billed')),
  before      jsonb,
  after       jsonb,
  reason      text,
  actor       uuid,
  created_at  timestamptz not null default now()
);
create index if not exists late_fee_audit_entity_idx on public.late_fee_audit (tenant_id, entity_type, entity_id, created_at desc);

alter table public.late_fee_audit enable row level security;
revoke all on table public.late_fee_audit from anon;
grant select on table public.late_fee_audit to authenticated;
grant all on table public.late_fee_audit to service_role;
drop policy if exists late_fee_audit_select on public.late_fee_audit;
create policy late_fee_audit_select on public.late_fee_audit
  for select to authenticated using (tenant_id = (select public.current_tenant_id()));
drop policy if exists late_fee_audit_service_role on public.late_fee_audit;
create policy late_fee_audit_service_role on public.late_fee_audit
  to service_role using (true) with check (true);

-- ── 4. What has been billed ──────────────────────────────────────────────────
create table if not exists public.late_charge_bills (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  invoice_id      text not null references public.invoices(id) on delete cascade,
  debit_note_id   text not null,
  fee_amount      integer not null check (fee_amount >= 0),
  interest_amount integer not null check (interest_amount >= 0),
  interest_from   date,
  interest_to     date,
  tax_rate        integer not null,
  gross_amount    integer not null check (gross_amount > 0),
  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index if not exists late_charge_bills_invoice_idx on public.late_charge_bills (tenant_id, invoice_id);
create unique index if not exists late_charge_bills_one_fee on public.late_charge_bills (tenant_id, invoice_id) where fee_amount > 0;

alter table public.late_charge_bills enable row level security;
revoke all on table public.late_charge_bills from anon;
grant select on table public.late_charge_bills to authenticated;
grant all on table public.late_charge_bills to service_role;
drop policy if exists late_charge_bills_select on public.late_charge_bills;
create policy late_charge_bills_select on public.late_charge_bills
  for select to authenticated using (tenant_id = (select public.current_tenant_id()));
drop policy if exists late_charge_bills_service_role on public.late_charge_bills;
create policy late_charge_bills_service_role on public.late_charge_bills
  to service_role using (true) with check (true);

commit;

begin;

-- ── 5. Company setting (owner only, audited) ─────────────────────────────────
create or replace function public.set_late_fee_settings(
  p_enabled boolean, p_interest_pct numeric, p_flat_fee integer, p_grace_days integer, p_registered_only boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_before jsonb;
  v_after  jsonb;
begin
  if v_tenant is null then
    raise exception 'You are not signed in to a company. Sign in again and retry.' using errcode = '42501';
  end if;
  if not public.current_user_is_owner() then
    raise exception 'Only the company owner can change late payment charges. Ask the owner to open Accounting > Aging.' using errcode = '42501';
  end if;
  if p_enabled is null or p_registered_only is null then
    raise exception 'Choose On or Off for late charges and for interest on registered customers.' using errcode = '22023';
  end if;
  if p_interest_pct is null or p_interest_pct < 0 or p_interest_pct > 36 then
    raise exception 'Interest must be between 0%% and 36%% a year. Enter a rate in that range.' using errcode = '22023';
  end if;
  if p_flat_fee is null or p_flat_fee < 0 or p_flat_fee > 100000 then
    raise exception 'The late fee must be between Rs 0 and Rs 1,00,000. Enter an amount in that range.' using errcode = '22023';
  end if;
  if p_grace_days is null or p_grace_days < 0 or p_grace_days > 90 then
    raise exception 'Grace days must be between 0 and 90. Enter a number in that range.' using errcode = '22023';
  end if;

  select jsonb_build_object('enabled', t.late_fee_enabled, 'interest_pct', t.late_interest_pct, 'flat_fee', t.late_fee_flat,
                            'grace_days', t.late_fee_grace_days, 'registered_only', t.late_interest_registered_only)
    into v_before from public.tenants t where t.id = v_tenant;

  update public.tenants t
     set late_fee_enabled = p_enabled,
         late_fee_enabled_at = case when p_enabled and not t.late_fee_enabled then now() else t.late_fee_enabled_at end,
         late_interest_pct = p_interest_pct,
         late_fee_flat = p_flat_fee,
         late_fee_grace_days = p_grace_days,
         late_interest_registered_only = p_registered_only
   where t.id = v_tenant;

  v_after := jsonb_build_object('enabled', p_enabled, 'interest_pct', p_interest_pct, 'flat_fee', p_flat_fee,
                                'grace_days', p_grace_days, 'registered_only', p_registered_only);
  if v_after is distinct from v_before then
    insert into public.late_fee_audit (tenant_id, entity_type, entity_id, action, before, after, actor)
    values (v_tenant, 'company', v_tenant::text, 'settings', v_before, v_after, auth.uid());
  end if;
  return v_after;
end;
$$;
revoke all on function public.set_late_fee_settings(boolean, numeric, integer, integer, boolean) from public;
revoke all on function public.set_late_fee_settings(boolean, numeric, integer, integer, boolean) from anon;
grant execute on function public.set_late_fee_settings(boolean, numeric, integer, integer, boolean) to authenticated, service_role;

-- ── 6. Default / On / Off for one customer, subscription or invoice ──────────
create or replace function public.set_late_fee_mode(p_entity_type text, p_entity_id text, p_mode text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_found  boolean;
  v_before text;
begin
  if v_tenant is null then
    raise exception 'You are not signed in to a company. Sign in again and retry.' using errcode = '42501';
  end if;
  if not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only the owner or a manager can switch late charges on or off. Ask one of them to change it.' using errcode = '42501';
  end if;
  if p_mode not in ('default', 'on', 'off') then
    raise exception 'Unknown choice "%". Use Default, On or Off.', p_mode using errcode = '22023';
  end if;

  v_found := case p_entity_type
    when 'customer'     then exists(select 1 from public.customers c where c.tenant_id = v_tenant and c.id::text = p_entity_id)
    when 'subscription' then exists(select 1 from public.subscriptions s where s.tenant_id = v_tenant and s.id::text = p_entity_id)
    when 'invoice'      then exists(select 1 from public.invoices i where i.tenant_id = v_tenant and i.id = p_entity_id)
    else null
  end;
  if v_found is null then
    raise exception 'Unknown level "%". Use customer, subscription or invoice.', p_entity_type using errcode = '22023';
  end if;
  if not v_found then
    raise exception 'That % was not found in your company. Refresh the page and try again.', p_entity_type using errcode = 'P0002';
  end if;

  select case when o.waived then 'waived' else o.mode end into v_before
    from public.late_fee_overrides o
   where o.tenant_id = v_tenant and o.entity_type = p_entity_type and o.entity_id = p_entity_id;
  v_before := coalesce(v_before, 'default');

  if p_mode = 'default' then
    delete from public.late_fee_overrides o
     where o.tenant_id = v_tenant and o.entity_type = p_entity_type and o.entity_id = p_entity_id;
  else
    insert into public.late_fee_overrides (tenant_id, entity_type, entity_id, mode, waived, waive_reason, updated_by, updated_at)
    values (v_tenant, p_entity_type, p_entity_id, p_mode, false, null, auth.uid(), now())
    on conflict (tenant_id, entity_type, entity_id) do update
      set mode = excluded.mode, waived = false, waive_reason = null,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end if;

  if v_before is distinct from p_mode then
    insert into public.late_fee_audit (tenant_id, entity_type, entity_id, action, before, after, actor)
    values (v_tenant, p_entity_type, p_entity_id, 'mode', to_jsonb(v_before), to_jsonb(p_mode), auth.uid());
  end if;
  return p_mode;
end;
$$;
revoke all on function public.set_late_fee_mode(text, text, text) from public;
revoke all on function public.set_late_fee_mode(text, text, text) from anon;
grant execute on function public.set_late_fee_mode(text, text, text) to authenticated, service_role;

-- ── 7. Waive (owner only, reason required) ──────────────────────────────────
create or replace function public.waive_late_charges(p_invoice_id text, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if v_tenant is null then
    raise exception 'You are not signed in to a company. Sign in again and retry.' using errcode = '42501';
  end if;
  if not public.current_user_is_owner() then
    raise exception 'Only the company owner can waive late charges. Ask the owner to open this invoice.' using errcode = '42501';
  end if;
  if length(v_reason) < 3 then
    raise exception 'Write why the late charges are waived (at least 3 letters) — it is kept on record.' using errcode = '22023';
  end if;
  if not exists(select 1 from public.invoices i where i.tenant_id = v_tenant and i.id = p_invoice_id) then
    raise exception 'Invoice % was not found in your company. Refresh the page and pick it again.', p_invoice_id using errcode = 'P0002';
  end if;

  insert into public.late_fee_overrides (tenant_id, entity_type, entity_id, mode, waived, waive_reason, updated_by, updated_at)
  values (v_tenant, 'invoice', p_invoice_id, 'off', true, v_reason, auth.uid(), now())
  on conflict (tenant_id, entity_type, entity_id) do update
    set mode = 'off', waived = true, waive_reason = excluded.waive_reason,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  insert into public.late_fee_audit (tenant_id, entity_type, entity_id, action, after, reason, actor)
  values (v_tenant, 'invoice', p_invoice_id, 'waived', to_jsonb('waived'::text), v_reason, auth.uid());
  return 'waived';
end;
$$;
revoke all on function public.waive_late_charges(text, text) from public;
revoke all on function public.waive_late_charges(text, text) from anon;
grant execute on function public.waive_late_charges(text, text) to authenticated, service_role;

-- ── 8. Effective state for one invoice (same precedence as lib/late-charges/rules.ts) ──
create or replace function public.late_fee_effective(p_invoice_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_inv    record;
  v_sub    text;
  v_o      record;
  v_on     boolean;
begin
  if v_tenant is null then
    raise exception 'You are not signed in to a company. Sign in again and retry.' using errcode = '42501';
  end if;
  select i.id, i.customer_id, i.quote_id into v_inv
    from public.invoices i where i.tenant_id = v_tenant and i.id = p_invoice_id;
  if not found then
    raise exception 'Invoice % was not found in your company.', p_invoice_id using errcode = 'P0002';
  end if;

  -- invoice
  select o.mode, o.waived into v_o from public.late_fee_overrides o
   where o.tenant_id = v_tenant and o.entity_type = 'invoice' and o.entity_id = p_invoice_id;
  if found then
    return jsonb_build_object('on', v_o.mode = 'on', 'source', 'invoice', 'waived', v_o.waived);
  end if;
  -- subscription (only when exactly one bills this invoice's quote, as the dunning cron reads it)
  if v_inv.quote_id is not null then
    select case when count(*) = 1 then min(s.id::text) end into v_sub
      from public.subscriptions s where s.tenant_id = v_tenant and s.quote_id = v_inv.quote_id;
    if v_sub is not null then
      select o.mode into v_o from public.late_fee_overrides o
       where o.tenant_id = v_tenant and o.entity_type = 'subscription' and o.entity_id = v_sub;
      if found then
        return jsonb_build_object('on', v_o.mode = 'on', 'source', 'subscription', 'waived', false);
      end if;
    end if;
  end if;
  -- customer
  if v_inv.customer_id is not null then
    select o.mode into v_o from public.late_fee_overrides o
     where o.tenant_id = v_tenant and o.entity_type = 'customer' and o.entity_id = v_inv.customer_id::text;
    if found then
      return jsonb_build_object('on', v_o.mode = 'on', 'source', 'customer', 'waived', false);
    end if;
  end if;
  select t.late_fee_enabled into v_on from public.tenants t where t.id = v_tenant;
  return jsonb_build_object('on', coalesce(v_on, false), 'source', 'company', 'waived', false);
end;
$$;
revoke all on function public.late_fee_effective(text) from public;
revoke all on function public.late_fee_effective(text) from anon;
grant execute on function public.late_fee_effective(text) to authenticated, service_role;

-- ── 9. Bill: a debit note at the invoice's own GST rate (owner only) ─────────
create or replace function public.bill_late_charges(
  p_invoice_id text, p_fee integer, p_interest integer, p_interest_from date, p_interest_to date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_inv     record;
  v_eff     jsonb;
  v_flat    integer;
  v_taxable integer;
  v_gross   integer;
  v_dn      jsonb;
  v_note    text;
begin
  if v_tenant is null then
    raise exception 'You are not signed in to a company. Sign in again and retry.' using errcode = '42501';
  end if;
  if not public.current_user_is_owner() then
    raise exception 'Only the company owner can bill late charges. Ask the owner to open this invoice.' using errcode = '42501';
  end if;
  if p_fee is null or p_fee < 0 or p_interest is null or p_interest < 0 or p_fee + p_interest <= 0 then
    raise exception 'There are no late charges to bill on invoice %. Refresh the page.', p_invoice_id using errcode = '22023';
  end if;

  select i.id, i.status::text as status, i.tax_rate, i.due_date into v_inv
    from public.invoices i where i.tenant_id = v_tenant and i.id = p_invoice_id for update;
  if not found then
    raise exception 'Invoice % was not found in your company. Refresh the page and pick it again.', p_invoice_id using errcode = 'P0002';
  end if;
  if v_inv.status not in ('pending', 'overdue', 'paid') then
    raise exception 'Invoice % is %, so it cannot carry late charges.', p_invoice_id, v_inv.status using errcode = '22023';
  end if;
  if v_inv.due_date is null then
    raise exception 'Invoice % has no due date, so it cannot be late.', p_invoice_id using errcode = '22023';
  end if;
  if v_inv.tax_rate is null then
    raise exception 'Invoice % has no GST rate stored, so the late charges cannot be taxed correctly. Ask your accountant which rate applies before billing.', p_invoice_id using errcode = '22023';
  end if;

  v_eff := public.late_fee_effective(p_invoice_id);
  if not coalesce((v_eff->>'on')::boolean, false) then
    raise exception 'Late charges are off for invoice % (set at %). Switch them on there first.', p_invoice_id, v_eff->>'source' using errcode = '22023';
  end if;

  if p_fee > 0 then
    if exists(select 1 from public.late_charge_bills b where b.tenant_id = v_tenant and b.invoice_id = p_invoice_id and b.fee_amount > 0) then
      raise exception 'The late fee on invoice % is already billed. It is charged only once.', p_invoice_id using errcode = '23505';
    end if;
    select t.late_fee_flat into v_flat from public.tenants t where t.id = v_tenant;
    if p_fee > coalesce(v_flat, 0) then
      raise exception 'The late fee (Rs %) is more than your company setting (Rs %). Refresh the page.', p_fee, coalesce(v_flat, 0) using errcode = '22023';
    end if;
  end if;

  v_taxable := p_fee + p_interest;
  v_gross := v_taxable + round(v_taxable * v_inv.tax_rate / 100.0)::integer;
  v_note := format('Late payment charges on %s (CGST s.15(2)(d)): late fee Rs %s + interest Rs %s%s, plus GST %s%%.',
                   p_invoice_id, p_fee, p_interest,
                   case when p_interest > 0 and p_interest_from is not null and p_interest_to is not null
                        then format(' (%s to %s)', p_interest_from, p_interest_to) else '' end,
                   v_inv.tax_rate);

  v_dn := public.issue_debit_note(p_invoice_id, v_gross, 'additional_charge', 'Late payment charges', v_note);
  if (v_dn->>'taxable_value')::integer is distinct from v_taxable then
    raise exception 'The debit note worked out a different taxable value (% vs %). Nothing was billed — report this.', v_dn->>'taxable_value', v_taxable;
  end if;

  -- A paid invoice now carries an unpaid debit note: it is owed again until that is received.
  update public.invoices i set status = 'pending', paid_date = null
   where i.id = p_invoice_id and i.tenant_id = v_tenant and i.status = 'paid'
     and coalesce(i.paid_amount, 0) < coalesce(i.net_payable, i.amount);

  insert into public.late_charge_bills (tenant_id, invoice_id, debit_note_id, fee_amount, interest_amount,
                                        interest_from, interest_to, tax_rate, gross_amount, created_by)
  values (v_tenant, p_invoice_id, v_dn->>'debit_note_id', p_fee, p_interest,
          case when p_interest > 0 then p_interest_from end, case when p_interest > 0 then p_interest_to end,
          v_inv.tax_rate, v_gross, auth.uid());

  insert into public.late_fee_audit (tenant_id, entity_type, entity_id, action, after, actor)
  values (v_tenant, 'invoice', p_invoice_id, 'billed',
          jsonb_build_object('debit_note_id', v_dn->>'debit_note_id', 'fee', p_fee, 'interest', p_interest,
                             'tax_rate', v_inv.tax_rate, 'gross', v_gross), auth.uid());

  return jsonb_build_object('debit_note_id', v_dn->>'debit_note_id', 'invoice_id', p_invoice_id,
                            'fee', p_fee, 'interest', p_interest, 'taxable', v_taxable,
                            'tax_rate', v_inv.tax_rate, 'gross', v_gross);
end;
$$;
revoke all on function public.bill_late_charges(text, integer, integer, date, date) from public;
revoke all on function public.bill_late_charges(text, integer, integer, date, date) from anon;
grant execute on function public.bill_late_charges(text, integer, integer, date, date) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
