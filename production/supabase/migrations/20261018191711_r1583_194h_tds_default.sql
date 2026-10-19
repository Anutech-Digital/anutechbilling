-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.fn_accrue_referral_commission()') and prosrc like '%tds_194h_default_rate%')
-- deploy-key: r1583tds194h
--
-- R-1583 (P1, 19 Oct 2026): partner commission TDS (s.194H) defaults to 2%, not 5%.
--
-- s.194H has been 2% since 1 Oct 2024 (Finance (No. 2) Act 2024) and the app's own
-- TDS_SECTION_RATES["194H"] says 2. The SQL that accrues commission still fell back to 5:
--   * fn_accrue_referral_commission (payments; baseline body) — coalesce(v_agr.tds_rate, 5);
--   * fn_accrue_referral_commission_project (20260926170000) — coalesce(v_agr.tds_rate, 2), a
--     second hard-coded copy of the rate;
--   * referral_partners / referral_agreements.tds_rate — created DEFAULT 5 (0156); a database
--     that never ran 20260926170000 still has it.
-- Now one SQL source, public.tds_194h_default_rate(), kept equal to TDS_SECTION_RATES by the
-- vitest guard src/lib/accounting/commission-tds-default.test.ts. Both column defaults and both
-- accrue functions use it.
--
-- An explicit rate on the agreement still wins (v_agr.tds_rate is read first; the column is
-- NOT NULL, so the fallback only guards a NULL). EXISTING rows are NOT changed: commissions
-- already accrued at 5% and agreements / partners that carry 5 stay as they are — listed by
-- scripts/r1583-commission-tds-5pct.mjs (report only) for Hitesh / the CA to decide (card R-1583
-- needsDecision).
--
-- Bodies are the current ones (baseline.sql for payments, 20260926170000 for project payments)
-- with only the TDS fallback changed.

create or replace function public.tds_194h_default_rate()
returns numeric
language sql
immutable
set search_path = public
as $$
  -- R-1583: s.194H commission TDS rate since 1 Oct 2024 = TDS_SECTION_RATES["194H"].ratePct
  select 2::numeric
$$;

comment on function public.tds_194h_default_rate() is
  'R-1583: default s.194H TDS % on partner commission (2% since 1 Oct 2024). Keep equal to TDS_SECTION_RATES["194H"] (guard: commission-tds-default.test.ts).';

grant execute on function public.tds_194h_default_rate() to authenticated;
grant execute on function public.tds_194h_default_rate() to service_role;

alter table public.referral_partners   alter column tds_rate set default public.tds_194h_default_rate();
alter table public.referral_agreements alter column tds_rate set default public.tds_194h_default_rate();

create or replace function public.fn_accrue_referral_commission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agr     public.referral_agreements%rowtype;
  v_taxrate numeric;
  v_base    integer;
  v_rate    numeric;
  v_gross   integer;
  v_tds     integer;
  v_exists  boolean;
begin
  if new.status is distinct from 'received' or new.refunded_at is not null or new.customer_id is null then
    return new;
  end if;

  begin
    select * into v_agr
    from public.referral_agreements
    where tenant_id = new.tenant_id
      and customer_id = new.customer_id
      and status = 'active'
    limit 1;
    if not found then
      return new;
    end if;

    if v_agr.scope = 'one_time' then
      select exists(
        select 1 from public.referral_commissions
        where agreement_id = v_agr.id and status <> 'cancelled'
      ) into v_exists;
      if v_exists then
        return new;
      end if;
    end if;

    select q.tax_rate into v_taxrate from public.quotes q where q.id = new.quote_id;
    if v_taxrate is null then v_taxrate := 18; end if;
    v_base := round(new.amount::numeric * 100.0 / (100.0 + v_taxrate))::integer;

    if v_agr.basis = 'percent' then
      v_rate  := coalesce(v_agr.percent, 0);
      v_gross := round(v_base::numeric * v_rate / 100.0)::integer;
    else
      v_rate  := null;
      v_gross := coalesce(v_agr.fixed_amount, 0);
    end if;

    if v_gross <= 0 then
      return new;
    end if;

    -- R-1583: the agreement's own rate; only a missing one falls back to s.194H (2%), never 5.
    if v_agr.deduct_tds then
      v_tds := round(v_gross::numeric * coalesce(v_agr.tds_rate, public.tds_194h_default_rate()) / 100.0)::integer;
    else
      v_tds := 0;
    end if;

    insert into public.referral_commissions (
      tenant_id, agreement_id, partner_id, customer_id, payment_id,
      base_amount, basis, rate, gross_commission, tds_amount, net_payable,
      status, earned_date
    ) values (
      new.tenant_id, v_agr.id, v_agr.partner_id, new.customer_id, new.id,
      v_base, v_agr.basis, v_rate, v_gross, v_tds, v_gross - v_tds,
      'earned', current_date
    )
    on conflict (agreement_id, payment_id) where payment_id is not null do nothing;

  exception when others then
    raise warning 'referral commission accrual failed for payment %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

create or replace function public.fn_accrue_referral_commission_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proj   public.project_sales;
  v_agr    public.referral_agreements%rowtype;
  v_base   integer;
  v_rate   numeric;
  v_gross  integer;
  v_tds    integer;
begin
  select * into v_proj from public.project_sales where id = new.project_id;
  if not found or v_proj.customer_id is null or coalesce(new.amount, 0) <= 0 then return new; end if;

  begin
    select * into v_agr from public.referral_agreements
     where tenant_id = new.tenant_id and customer_id = v_proj.customer_id and status = 'active'
     limit 1;
    if not found then return new; end if;

    if v_agr.scope = 'one_time' and exists (
      select 1 from public.referral_commissions where agreement_id = v_agr.id and status <> 'cancelled'
    ) then
      return new;
    end if;

    v_base := round(new.amount::numeric * 100.0 / (100.0 + coalesce(v_proj.gst_rate, 18)))::integer;

    if v_agr.basis = 'percent' then
      v_rate  := coalesce(v_agr.percent, 0);
      v_gross := round(v_base::numeric * v_rate / 100.0)::integer;
    else
      if new.method = 'tds' then return new; end if;   -- one fixed fee per instalment
      v_rate  := null;
      v_gross := coalesce(v_agr.fixed_amount, 0);
    end if;
    if v_gross <= 0 then return new; end if;

    -- R-1583: same fallback as payments — the one SQL source of the s.194H rate.
    v_tds := case when v_agr.deduct_tds then round(v_gross::numeric * coalesce(v_agr.tds_rate, public.tds_194h_default_rate()) / 100.0)::integer else 0 end;

    insert into public.referral_commissions (
      tenant_id, agreement_id, partner_id, customer_id, project_payment_id,
      base_amount, basis, rate, gross_commission, tds_amount, net_payable, status, earned_date, notes
    ) values (
      new.tenant_id, v_agr.id, v_agr.partner_id, v_proj.customer_id, new.id,
      v_base, v_agr.basis, v_rate, v_gross, v_tds, v_gross - v_tds, 'earned', coalesce(new.received_at, current_date),
      format('Project "%s"%s', v_proj.title, case when new.method = 'tds' then ' — TDS part of the instalment' else '' end)
    )
    on conflict (agreement_id, project_payment_id) where project_payment_id is not null do nothing;
  exception when others then
    raise warning 'referral commission accrual failed for project payment %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
