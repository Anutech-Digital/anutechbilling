-- deploy-peek: to_regclass('public.tenant_luts') is not null and to_regprocedure('public.lut_for(uuid,date)') is not null and exists (select 1 from pg_proc where proname = 'reconcile_bank_credit_new_sale_fx' and prosrc like '%R-2444%')
-- deploy-key: r2444lutperfy
--
-- R-2444 (4 Nov 2026, p1 money) — the LUT per financial year, and an LUT check on EVERY 0% export path.
--
-- THE HOLE (R-2440 review.left 1-2; tax memo 3 Nov §1-2):
--   (1) Only the USD bank booking (reconcile_bank_credit_new_sale_fx) checked for an LUT. A sale for a
--       foreign customer booked in ₹ (Find in Zoho at the bank rate, a sale entered by hand, a quote
--       turned into an invoice) still went out at 0% GST with no LUT — IGST is then payable on it.
--   (2) The company held ONE LUT (tenants.lut_number + lut_valid_upto, no valid-from), so an FY 2025-26
--       receipt was refused while Settings held the FY 2026-27 LUT (Zoho backlog). An LUT is filed per
--       FY (Form RFD-11), and the invoice must carry the ARN of ITS year (CGST rule 46).
--
-- WHAT THIS DOES
--   1. tenant_luts (tenant, fy_start = 1 April, arn, valid_from, valid_upto) — one LUT per company per
--      FY. The existing tenants LUT moves in (its FY = the FY of its "valid up to").
--   2. lut_for(tenant, date) → the ARN covering that date (null = none). export_lut_refusal(tenant,
--      date) → null, or the §24 refusal: which FY has no LUT, and the next step (add it in Settings →
--      Company → LUT; file RFD-11 if there is none). TS twin: lutFor / exportLutRefusal in src/lib/gst/export-lut.ts.
--   3. EVERY 0% export path refuses without it — one BEFORE INSERT trigger on invoices
--      (trg_invoices_zz_export_lut, runs after the party snapshot fills gst_treatment): a Tax Invoice to
--      an 'overseas' customer (or one whose country is outside India) with no GST needs the LUT of its
--      invoice date's FY. That covers generate_invoice (quote → invoice), raise_subscription_billing,
--      the bank sale RPCs (Find in Zoho / Reconcile from Zoho), project and direct invoices — without
--      copying their bodies. An invoice that charges GST is never refused; opening invoices (Zoho
--      import) and Bills of Supply are not ours to zero-rate and are left alone.
--   4. reconcile_bank_credit_new_sale_fx (11 args, latest body R-2440 20261103163318) and the 12-arg
--      overload (latest body R-2427 20261104001617) read the LUT through export_lut_refusal instead of
--      tenants.lut_number — the only change in their bodies.
--   5. save_tenant_lut / delete_tenant_lut (owner or accountant) for Settings → Company's LUT list.
--      Delete is refused while an export invoice of that FY relies on it (edit it instead).
--   6. tenants.lut_number / lut_valid_upto stay readable for old code (compliance reminders, AI help
--      facts): they mirror the LATEST FY's LUT. An old writer of those two columns (old Settings form,
--      older tests) still works: its old value's row is replaced by the new one.
-- Test: supabase/tests/r2444_lut_per_fy.test.sql (begin … rollback; red without this file).

begin;

-- ── 1. The table ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.tenant_luts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  fy_start    date not null,
  arn         text not null,
  valid_from  date not null,
  valid_upto  date not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint tenant_luts_one_per_fy unique (tenant_id, fy_start),
  constraint tenant_luts_fy_start_april check (extract(month from fy_start) = 4 and extract(day from fy_start) = 1),
  constraint tenant_luts_arn_check check (btrim(arn) <> '' and length(arn) <= 40),
  constraint tenant_luts_dates_in_fy check (valid_from >= fy_start and valid_upto <= (fy_start + interval '1 year' - interval '1 day')::date
                                            and valid_from <= valid_upto)
);
comment on table public.tenant_luts is
  'R-2444: the company''s Letter of Undertaking (Form RFD-11) per financial year — a 0% export needs the LUT of its date''s FY; the invoice prints its ARN (CGST rule 46).';

alter table public.tenant_luts enable row level security;
revoke all on public.tenant_luts from public, anon, authenticated;
grant select on public.tenant_luts to authenticated;
grant all on public.tenant_luts to service_role;
drop policy if exists tenant_luts_read on public.tenant_luts;
create policy tenant_luts_read on public.tenant_luts
  for select to authenticated using (tenant_id = (select public.current_tenant_id()));
/* R-450: Cloud SQL has no BYPASSRLS — the server (service_role) client needs its own policy. */
drop policy if exists tenant_luts_service_role on public.tenant_luts;
create policy tenant_luts_service_role on public.tenant_luts
  for all to service_role using (true) with check (true);

-- ── 2. The FY of a date, the LUT for a date, and the refusal ───────────────────────────────────
create or replace function public.lut_fy_start(p_date date)
returns date
language sql
immutable
set search_path = public
as $$
  select make_date(extract(year from p_date)::int - case when extract(month from p_date) >= 4 then 0 else 1 end, 4, 1)
$$;

create or replace function public.lut_fy_label(p_date date)
returns text
language sql
immutable
set search_path = public
as $$
  select extract(year from public.lut_fy_start(p_date))::int || '-'
         || lpad(((extract(year from public.lut_fy_start(p_date))::int + 1) % 100)::text, 2, '0')
$$;

/* The ARN of the LUT that covers p_date (its FY's row, valid_from ≤ date ≤ valid_upto), else null.
   SECURITY INVOKER: an app user reads only their own company's rows (RLS); the triggers and RPCs
   below are SECURITY DEFINER. */
create or replace function public.lut_for(p_tenant uuid, p_date date)
returns text
language sql
stable
set search_path = public
as $$
  select l.arn from public.tenant_luts l
   where l.tenant_id = p_tenant and l.fy_start = public.lut_fy_start(p_date)
     and p_date between l.valid_from and l.valid_upto
$$;

/* Null = a 0% export on p_date is covered by an LUT. Else the refusal, with the next step. */
create or replace function public.export_lut_refusal(p_tenant uuid, p_date date)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_row public.tenant_luts%rowtype;
  v_fy  text := public.lut_fy_label(p_date);
begin
  if p_date is null then
    return 'An export at 0% GST needs a date to find its LUT.';
  end if;
  if public.lut_for(p_tenant, p_date) is not null then
    return null;
  end if;
  select * into v_row from public.tenant_luts l where l.tenant_id = p_tenant and l.fy_start = public.lut_fy_start(p_date);
  if found then
    return format('No LUT for FY %s covers %s: the LUT saved for that year runs %s – %s. An export at 0%% GST needs a Letter of Undertaking on its date: correct the LUT dates in Settings → Company → LUT, then try again.',
                  v_fy, to_char(p_date, 'DD Mon YYYY'), to_char(v_row.valid_from, 'DD Mon YYYY'), to_char(v_row.valid_upto, 'DD Mon YYYY'));
  end if;
  return format('No LUT for FY %s on file. An export sale at 0%% GST needs your Letter of Undertaking for that year: add its ARN in Settings → Company → LUT (file Form GST RFD-11 on gst.gov.in if you have none), then try again.', v_fy);
end;
$$;

revoke all on function public.lut_fy_start(date) from public, anon;
revoke all on function public.lut_fy_label(date) from public, anon;
revoke all on function public.lut_for(uuid, date) from public, anon;
revoke all on function public.export_lut_refusal(uuid, date) from public, anon;
grant execute on function public.lut_fy_start(date) to authenticated, service_role;
grant execute on function public.lut_fy_label(date) to authenticated, service_role;
grant execute on function public.lut_for(uuid, date) to authenticated, service_role;
grant execute on function public.export_lut_refusal(uuid, date) to authenticated, service_role;

-- ── 3. tenants.lut_number / lut_valid_upto mirror the latest FY's LUT ──────────────────────────
create or replace function public.tenant_lut_mirror(p_tenant uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_arn text; v_upto date;
begin
  select l.arn, l.valid_upto into v_arn, v_upto from public.tenant_luts l
   where l.tenant_id = p_tenant order by l.fy_start desc limit 1;
  perform set_config('app.r2444_lut_mirror', 'on', true);
  update public.tenants set lut_number = v_arn, lut_valid_upto = v_upto
   where id = p_tenant and (lut_number is distinct from v_arn or lut_valid_upto is distinct from v_upto);
  perform set_config('app.r2444_lut_mirror', '', true);
end;
$$;
revoke all on function public.tenant_lut_mirror(uuid) from public, anon, authenticated;
grant execute on function public.tenant_lut_mirror(uuid) to service_role;

/* An old writer of tenants.lut_number / lut_valid_upto (old Settings form, older tests): its OLD value's
   row goes, its NEW value lands in that value's FY. Not when the mirror itself wrote them. */
create or replace function public.tg_tenants_lut_to_fy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_arn text; v_new_arn text;
begin
  if coalesce(current_setting('app.r2444_lut_mirror', true), '') = 'on' then
    return new;
  end if;
  v_new_arn := nullif(btrim(coalesce(new.lut_number, '')), '');
  if tg_op = 'UPDATE' then
    if new.lut_number is not distinct from old.lut_number and new.lut_valid_upto is not distinct from old.lut_valid_upto then
      return new;
    end if;
    v_old_arn := nullif(btrim(coalesce(old.lut_number, '')), '');
    /* Not when 0% export invoices of that FY rely on it (delete_tenant_lut's rule) — then it stays. */
    if v_old_arn is not null and old.lut_valid_upto is not null
       and not exists (select 1 from public.invoices i
                        where i.tenant_id = new.id and i.document_kind = 'tax_invoice'
                          and coalesce(i.tax_amount, 0) = 0 and coalesce(i.tax_rate, 0) = 0
                          and (i.gst_treatment = 'overseas'
                               or coalesce(nullif(lower(btrim(i.customer_country)), ''), 'india') not in ('india', 'in', 'ind', 'bharat'))
                          and i.invoice_date >= public.lut_fy_start(old.lut_valid_upto)
                          and i.invoice_date < (public.lut_fy_start(old.lut_valid_upto) + interval '1 year')::date) then
      delete from public.tenant_luts
       where tenant_id = new.id and fy_start = public.lut_fy_start(old.lut_valid_upto) and arn = v_old_arn;
    end if;
  end if;
  if v_new_arn is not null and new.lut_valid_upto is not null and length(v_new_arn) <= 40 then
    insert into public.tenant_luts (tenant_id, fy_start, arn, valid_from, valid_upto)
    values (new.id, public.lut_fy_start(new.lut_valid_upto), v_new_arn, public.lut_fy_start(new.lut_valid_upto), new.lut_valid_upto)
    on conflict (tenant_id, fy_start) do update
      set arn = excluded.arn, valid_upto = excluded.valid_upto,
          valid_from = least(public.tenant_luts.valid_from, excluded.valid_upto), updated_at = now();
  end if;
  return new;
end;
$$;
revoke all on function public.tg_tenants_lut_to_fy() from public, anon, authenticated;
drop trigger if exists trg_tenants_lut_to_fy on public.tenants;
create trigger trg_tenants_lut_to_fy
  after insert or update of lut_number, lut_valid_upto on public.tenants
  for each row execute function public.tg_tenants_lut_to_fy();

-- ── 4. Backfill: the one LUT on file moves to its FY ───────────────────────────────────────────
insert into public.tenant_luts (tenant_id, fy_start, arn, valid_from, valid_upto)
select t.id, public.lut_fy_start(t.lut_valid_upto), btrim(t.lut_number), public.lut_fy_start(t.lut_valid_upto), t.lut_valid_upto
  from public.tenants t
 where nullif(btrim(coalesce(t.lut_number, '')), '') is not null and t.lut_valid_upto is not null
   and length(btrim(t.lut_number)) <= 40
on conflict (tenant_id, fy_start) do nothing;

-- ── 5. Settings → Company: add / edit / delete an LUT ──────────────────────────────────────────
create or replace function public.save_tenant_lut(p_fy_start date, p_arn text, p_valid_from date, p_valid_upto date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t    uuid := public.current_tenant_id();
  v_arn  text := upper(btrim(coalesce(p_arn, '')));
  v_fy   date := public.lut_fy_start(p_fy_start);
  v_end  date;
  v_from date;
  v_upto date;
  v_id   uuid;
begin
  if v_t is null then raise exception 'No company on this login — sign in again.' using errcode = '28000'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can change the company''s LUT.' using errcode = '42501';
  end if;
  if p_fy_start is null or p_fy_start <> v_fy then
    raise exception 'Pick the financial year (it starts on 1 April).' using errcode = '22023';
  end if;
  if v_arn = '' or length(v_arn) > 40 then
    raise exception 'Enter the LUT''s ARN (up to 40 characters), as on the RFD-11 acknowledgement.' using errcode = '22023';
  end if;
  v_end  := (v_fy + interval '1 year' - interval '1 day')::date;
  v_from := coalesce(p_valid_from, v_fy);
  v_upto := coalesce(p_valid_upto, v_end);
  if v_from < v_fy or v_upto > v_end or v_from > v_upto then
    raise exception 'The LUT dates must fall inside FY % (% – %), "from" before "up to".',
      public.lut_fy_label(v_fy), to_char(v_fy, 'DD Mon YYYY'), to_char(v_end, 'DD Mon YYYY') using errcode = '22023';
  end if;
  insert into public.tenant_luts (tenant_id, fy_start, arn, valid_from, valid_upto)
  values (v_t, v_fy, v_arn, v_from, v_upto)
  on conflict (tenant_id, fy_start) do update
    set arn = excluded.arn, valid_from = excluded.valid_from, valid_upto = excluded.valid_upto, updated_at = now()
  returning id into v_id;
  perform public.tenant_lut_mirror(v_t);
  return jsonb_build_object('id', v_id, 'fy', public.lut_fy_label(v_fy), 'arn', v_arn, 'valid_from', v_from, 'valid_upto', v_upto);
end;
$$;

create or replace function public.delete_tenant_lut(p_fy_start date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t  uuid := public.current_tenant_id();
  v_fy date := public.lut_fy_start(p_fy_start);
  v_n  int;
begin
  if v_t is null then raise exception 'No company on this login — sign in again.' using errcode = '28000'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can change the company''s LUT.' using errcode = '42501';
  end if;
  select count(*) into v_n from public.invoices i
   where i.tenant_id = v_t and i.document_kind = 'tax_invoice'
     and (i.gst_treatment = 'overseas'
          or coalesce(nullif(lower(btrim(i.customer_country)), ''), 'india') not in ('india', 'in', 'ind', 'bharat'))
     and coalesce(i.tax_amount, 0) = 0 and coalesce(i.tax_rate, 0) = 0
     and i.invoice_date >= v_fy and i.invoice_date < (v_fy + interval '1 year')::date;
  if v_n > 0 then
    raise exception '% export invoice(s) of FY % were issued at 0%% GST under this LUT — correct its ARN or dates instead of deleting it.',
      v_n, public.lut_fy_label(v_fy) using errcode = 'check_violation';
  end if;
  delete from public.tenant_luts where tenant_id = v_t and fy_start = v_fy;
  perform public.tenant_lut_mirror(v_t);
end;
$$;
revoke all on function public.save_tenant_lut(date, text, date, date) from public, anon;
revoke all on function public.delete_tenant_lut(date) from public, anon;
grant execute on function public.save_tenant_lut(date, text, date, date) to authenticated, service_role;
grant execute on function public.delete_tenant_lut(date) to authenticated, service_role;

-- ── 6. Every 0% export invoice needs the LUT of its date's FY ──────────────────────────────────
create or replace function public.tg_invoice_export_needs_lut()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg text;
begin
  /* R-2444. Runs after trg_invoice_document_kind and trg_invoice_snapshot_parties (name order), so
     document_kind, gst_treatment and customer_country are already set. An export = treatment
     'overseas' OR a customer country outside India (generate_invoice decides 0% on the country, and a
     customer whose country changed may still carry an old treatment). GST charged → no LUT needed. */
  if new.document_kind is distinct from 'tax_invoice'
     or (new.gst_treatment is distinct from 'overseas'
         and coalesce(nullif(lower(btrim(new.customer_country)), ''), 'india') in ('india', 'in', 'ind', 'bharat'))
     or coalesce(new.tax_amount, 0) <> 0 or coalesce(new.tax_rate, 0) <> 0
     or coalesce(new.taxable_value, new.amount, 0) <= 0 then
    return new;
  end if;
  v_msg := public.export_lut_refusal(new.tenant_id, coalesce(new.invoice_date, public.ist_today()));
  if v_msg is not null then
    raise exception '%', v_msg using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_invoice_export_needs_lut() from public, anon, authenticated;
drop trigger if exists trg_invoices_zz_export_lut on public.invoices;
create trigger trg_invoices_zz_export_lut
  before insert on public.invoices
  for each row execute function public.tg_invoice_export_needs_lut();

-- ── 7. The bank export-sale RPCs read the LUT per FY (latest bodies; only the LUT block changed) ──
create or replace function public.reconcile_bank_credit_new_sale_fx(
  p_txn_id              uuid,
  p_customer_id         uuid,
  p_lines               jsonb,
  p_create_subscription boolean,
  p_sub_start           date,
  p_sub_renewal         date,
  p_billing_cycle       text,
  p_external_number     text,
  p_currency            text,
  p_fx_rate             numeric,
  p_foreign_amount      numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller  uuid;
  v_trusted boolean;
  v_cur     text := upper(btrim(coalesce(p_currency, '')));
  v_txn     record;
  v_country text;
  v_res     jsonb;
  v_quote   text;
  v_invs    int := 0;
  v_m       text[];
  v_n_amt   numeric;
  v_n_rate  numeric;
  v_lut     text;
  v_lut_upto date;
  v_fy_end  date;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;

  /* R-2440: the codes inward-remittance.ts reads (its CODES list) — never INR, never a made-up one. */
  if v_cur not in ('USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'CHF', 'JPY', 'NZD', 'HKD', 'SAR') then
    raise exception 'A foreign-currency sale needs one of USD, EUR, GBP, AED, SGD, AUD, CAD, CHF, JPY, NZD, HKD, SAR (got "%").', coalesce(p_currency, '') using errcode = '22023';
  end if;
  if coalesce(p_fx_rate, 0) <= 0 or coalesce(p_foreign_amount, 0) <= 0 then
    raise exception 'A foreign-currency sale needs the foreign amount and the bank''s rate.' using errcode = '22023';
  end if;

  select t.id, t.tenant_id, t.credit, t.txn_date, t.description into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if abs(round(p_foreign_amount * p_fx_rate, 2) - coalesce(v_txn.credit, 0)) > 1 then
    raise exception 'The bank line is ₹%, but % % at ₹% is ₹%. Check the amount and rate in the bank narration.',
      v_txn.credit, v_cur, p_foreign_amount, p_fx_rate, round(p_foreign_amount * p_fx_rate, 2)
      using errcode = 'check_violation';
  end if;

  /* R-2440: the bank's own words. Same pattern as parseInwardRemittance (case ignored: upper()). */
  v_m := regexp_match(upper(coalesce(v_txn.description, '')),
           '(?:^|[^A-Z])(USD|EUR|GBP|AED|SGD|AUD|CAD|CHF|JPY|NZD|HKD|SAR)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*@\s*([0-9]+(?:\.[0-9]+)?)');
  if v_m is not null then
    v_n_amt := replace(v_m[2], ',', '')::numeric;
    v_n_rate := v_m[3]::numeric;
  end if;
  if v_m is null or coalesce(v_n_amt, 0) <= 0 or coalesce(v_n_rate, 0) <= 0 then
    raise exception 'This bank line''s narration has no foreign amount and rate (like "USD1024.0@93.6"), so it cannot be booked in %. Reconcile it by hand as a ₹ sale.', v_cur
      using errcode = 'check_violation';
  end if;
  if v_m[1] <> v_cur or abs(v_n_amt - p_foreign_amount) > 0.005 or abs(v_n_rate - p_fx_rate) > 0.00005 then
    raise exception 'The bank narration says % % @ ₹%, but this sale was sent as % % @ ₹%. Reload the page and try again.',
      v_m[1], trim_scale(v_n_amt), trim_scale(v_n_rate), v_cur, p_foreign_amount, p_fx_rate
      using errcode = 'check_violation';
  end if;

  select c.country into v_country from public.customers c
   where c.id = p_customer_id and c.tenant_id = v_txn.tenant_id;
  if not found then raise exception 'Customer not found in this company' using errcode = '42501'; end if;
  if coalesce(nullif(lower(btrim(v_country)), ''), 'india') in ('india', 'in', 'ind', 'bharat') then
    raise exception 'Money in % is booked as an export sale, but this customer is in India. Set the customer''s country, or reconcile this line by hand.', v_cur
      using errcode = 'check_violation';
  end if;

  /* R-2440 → R-2444: 0% export only under the LUT of the bank line's financial year — tenant_luts,
     one row per FY, read by export_lut_refusal (lut_for). Same words on every export path. */
  v_lut := public.export_lut_refusal(v_txn.tenant_id, v_txn.txn_date);
  if v_lut is not null then
    raise exception '%', v_lut using errcode = 'check_violation';
  end if;

  v_res := public.reconcile_bank_credit_new_sale(
             p_txn_id, p_customer_id, p_lines, p_create_subscription, p_sub_start, p_sub_renewal,
             0, null, null, p_billing_cycle, p_external_number);

  v_quote := nullif(v_res->>'quote_id', '');
  if v_quote is null or coalesce((v_res->>'already_recorded')::boolean, false) then
    /* R-2440 (review minor 6): nothing was stamped — say so, no currency. */
    return v_res || jsonb_build_object('fx_invoices', 0);
  end if;

  update public.quotes
     set currency = v_cur, exchange_rate = v_n_rate, fx_source = 'manual', fx_date = v_txn.txn_date
   where id = v_quote and tenant_id = v_txn.tenant_id;
  /* The invoice raised in this same call was snapshotted from the still-INR quote: give it the
     currency now (trg_invoice_fx_freeze allows null → value). */
  update public.invoices
     set currency = v_cur, fx_rate = v_n_rate, fx_source = 'manual', fx_date = v_txn.txn_date
   where quote_id = v_quote and tenant_id = v_txn.tenant_id and fx_rate is null;
  get diagnostics v_invs = row_count;

  return v_res || jsonb_build_object(
    'currency', v_cur, 'fx_rate', v_n_rate, 'foreign_amount', v_n_amt, 'fx_invoices', v_invs);
end;
$$;

revoke all on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) from public, anon;
grant execute on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) to authenticated, service_role;

comment on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) is
  'R-2425/R-2440/R-2444: an export receipt (foreign inward remittance) booked as a new sale — reconcile_bank_credit_new_sale (11 args, no TDS) + the quote and its invoice stamped with the currency and the bank''s rate, in one transaction. Refused unless the currency, foreign amount and rate are the ones in the bank line''s narration, foreign amount × rate = the bank credit (±₹1), the customer is outside India and the company has an LUT for the line''s financial year (tenant_luts, R-2444).';

create or replace function public.reconcile_bank_credit_new_sale_fx(
  p_txn_id              uuid,
  p_customer_id         uuid,
  p_lines               jsonb,
  p_create_subscription boolean,
  p_sub_start           date,
  p_sub_renewal         date,
  p_billing_cycle       text,
  p_external_number     text,
  p_currency            text,
  p_fx_rate             numeric,
  p_foreign_amount      numeric,
  p_foreign_billed      numeric      -- R-2427: Zoho's amount; more than p_foreign_amount = charges kept abroad
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid;
  v_trusted  boolean;
  v_cur      text := upper(btrim(coalesce(p_currency, '')));
  v_txn      record;
  v_n        jsonb;
  v_country  text;
  v_lut      text;
  v_lut_upto date;
  v_fy_end   date;
  v_lock     date;
  v_short    numeric;
  v_sale     jsonb;
  v_total    integer;
  v_charges  integer;
  v_ref      text;
  v_core     jsonb;
  v_pay_id   uuid;
  v_quote    text;
  v_inv      text;
  v_invs     int := 0;
  v_num      text;
  v_saved    boolean := false;
begin
  /* No short (or not given): exactly R-2440's 11-argument function. */
  if p_foreign_billed is null or abs(p_foreign_billed - coalesce(p_foreign_amount, 0)) <= 0.005 then
    return public.reconcile_bank_credit_new_sale_fx(p_txn_id, p_customer_id, p_lines, p_create_subscription,
             p_sub_start, p_sub_renewal, p_billing_cycle, p_external_number, p_currency, p_fx_rate, p_foreign_amount);
  end if;

  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;
  if v_cur not in ('USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'CHF', 'JPY', 'NZD', 'HKD', 'SAR') then
    raise exception 'A foreign-currency sale needs one of USD, EUR, GBP, AED, SGD, AUD, CAD, CHF, JPY, NZD, HKD, SAR (got "%").', coalesce(p_currency, '') using errcode = '22023';
  end if;
  if coalesce(p_fx_rate, 0) <= 0 or coalesce(p_foreign_amount, 0) <= 0 then
    raise exception 'A foreign-currency sale needs the foreign amount and the bank''s rate.' using errcode = '22023';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  v_n := public.bank_fx_narration(v_txn.description);
  if v_n is null then
    raise exception 'This bank line''s narration has no foreign amount and rate (like "USD1024.0@93.6"), so it cannot be booked in %. Reconcile it by hand as a ₹ sale.', v_cur
      using errcode = 'check_violation';
  end if;
  if v_n->>'currency' <> v_cur or abs((v_n->>'amount')::numeric - p_foreign_amount) > 0.005
     or abs((v_n->>'rate')::numeric - p_fx_rate) > 0.00005 then
    raise exception 'The bank narration says % % @ ₹%, but this sale was sent as % % @ ₹%. Reload the page and try again.',
      v_n->>'currency', trim_scale((v_n->>'amount')::numeric), trim_scale((v_n->>'rate')::numeric), v_cur, p_foreign_amount, p_fx_rate
      using errcode = 'check_violation';
  end if;
  if abs(round(p_foreign_amount * p_fx_rate, 2) - coalesce(v_txn.credit, 0)) > 1 then
    raise exception 'The bank line is ₹%, but % % at ₹% is ₹%. Check the amount and rate in the bank narration.',
      v_txn.credit, v_cur, p_foreign_amount, p_fx_rate, round(p_foreign_amount * p_fx_rate, 2)
      using errcode = 'check_violation';
  end if;

  v_short := p_foreign_billed - p_foreign_amount;
  if v_short < 0 then
    raise exception 'Zoho billed % % but the bank got % % — more came in than was billed. Reconcile this line by hand.',
      v_cur, trim_scale(p_foreign_billed), v_cur, trim_scale(p_foreign_amount) using errcode = 'check_violation';
  end if;
  if v_short > p_foreign_billed * 0.05 then
    raise exception 'Zoho billed % % but the bank got % % — % short is more than bank charges (5%%). Reconcile this line by hand.',
      v_cur, trim_scale(p_foreign_billed), v_cur, trim_scale(p_foreign_amount), trim_scale(v_short) using errcode = 'check_violation';
  end if;

  select c.country into v_country from public.customers c
   where c.id = p_customer_id and c.tenant_id = v_txn.tenant_id;
  if not found then raise exception 'Customer not found in this company' using errcode = '42501'; end if;
  if coalesce(nullif(lower(btrim(v_country)), ''), 'india') in ('india', 'in', 'ind', 'bharat') then
    raise exception 'Money in % is booked as an export sale, but this customer is in India. Set the customer''s country, or reconcile this line by hand.', v_cur
      using errcode = 'check_violation';
  end if;

  /* R-2444: the LUT of the bank line's financial year (tenant_luts via export_lut_refusal). */
  select tn.books_locked_until into v_lock from public.tenants tn where tn.id = v_txn.tenant_id;
  v_lut := public.export_lut_refusal(v_txn.tenant_id, v_txn.txn_date);
  if v_lut is not null then
    raise exception '%', v_lut using errcode = 'check_violation';
  end if;
  if v_lock is not null and v_txn.txn_date <= v_lock then
    raise exception 'The books are locked up to %, and this bank line is dated % — unlock the books first.', to_char(v_lock, 'DD Mon YYYY'), to_char(v_txn.txn_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;
  if public.bank_sale_lines_below_cost(p_lines) then
    raise exception 'This sale is priced below cost and needs approval first — with charges kept abroad it cannot wait for approval here. Reconcile this line by hand.'
      using errcode = 'check_violation';
  end if;

  /* The sale at the BILLED amount, paid in full. */
  v_sale := public.bank_credit_new_sale_quote(p_txn_id, p_customer_id, p_lines, p_billing_cycle);
  v_quote := v_sale->>'quote_id';
  v_total := (v_sale->>'quote_total')::int;
  if abs(v_total - round(p_foreign_billed * p_fx_rate)) > 1 then
    raise exception 'The sale comes to ₹%, but % % billed at the bank''s rate ₹% is ₹%. Reconcile this line by hand.',
      v_total, v_cur, trim_scale(p_foreign_billed), p_fx_rate, round(p_foreign_billed * p_fx_rate)
      using errcode = 'check_violation';
  end if;
  v_charges := v_total - round(v_txn.credit)::int;
  if v_charges <= 0 then
    raise exception 'Nothing is short on this line — book it without the billed amount.' using errcode = 'check_violation';
  end if;

  v_ref := public.bank_line_payment_reference(v_txn.reference, v_txn.id);
  v_core := public.bank_credit_pay_item(
    p_txn_id, v_total, v_ref, v_quote, null, 0, null, null, p_create_subscription, p_sub_start, p_sub_renewal);
  v_pay_id := (v_core->>'payment_id')::uuid;
  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_pay_id::text, 'manual');

  update public.quotes
     set currency = v_cur, exchange_rate = p_fx_rate, fx_source = 'manual', fx_date = v_txn.txn_date
   where id = v_quote and tenant_id = v_txn.tenant_id;
  update public.invoices
     set currency = v_cur, fx_rate = p_fx_rate, fx_source = 'manual', fx_date = v_txn.txn_date
   where quote_id = v_quote and tenant_id = v_txn.tenant_id and fx_rate is null;
  get diagnostics v_invs = row_count;
  select q.invoice_id into v_inv from public.quotes q where q.id = v_quote;

  perform public.bank_fx_book_differences(p_txn_id, v_pay_id, v_charges, 0,
    'sale ' || v_quote || ': ' || v_cur || ' ' || trim_scale(p_foreign_billed) || ' billed, ' || v_cur || ' '
    || trim_scale(p_foreign_amount) || ' @ ₹' || trim_scale(p_fx_rate) || ' received');

  v_num := public.zoho_external_number_clean(p_external_number);
  if v_num is not null then
    v_saved := public.bank_sale_keep_external_number(p_txn_id, v_inv, v_num);
  end if;

  return public.bank_credit_item_result(v_txn.tenant_id, v_core, null, v_total, 0)
         || jsonb_build_object('new_quote', true, 'quote_total', v_total, 'tax_rate', (v_sale->>'tax_rate')::int,
                               'currency', v_cur, 'fx_rate', p_fx_rate, 'foreign_amount', p_foreign_amount,
                               'foreign_billed', p_foreign_billed, 'bank_charges', v_charges, 'forex_difference', 0,
                               'fx_invoices', v_invs, 'external_number', v_num, 'external_number_saved', v_saved);
end;
$$;
revoke all on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric, numeric) from public, anon;
grant execute on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric, numeric) to authenticated, service_role;
comment on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric, numeric) is
  'R-2427/R-2444: an export receipt booked as a new sale when Zoho billed more than the bank got (charges kept abroad, ≤ 5%): the sale at the billed amount paid in full, quote + invoice in the currency at the bank''s rate, the short part → Bank Charges (a paid expense tied to the line). No short → R-2440''s 11-argument function. One transaction; tenant fail-closed; money roles; line lock; books lock; narration, outside-India and LUT (tenant_luts, R-2444) checks as R-2440.';


commit;
