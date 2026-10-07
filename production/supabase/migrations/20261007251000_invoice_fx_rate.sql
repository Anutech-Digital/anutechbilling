-- deploy-key: invfx
-- deploy-peek: (exists(select 1 from pg_trigger where tgname='trg_invoice_fx_snapshot') and exists(select 1 from pg_trigger where tgname='trg_invoice_fx_freeze') and exists(select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='fx_source'))
-- 20261007251000_invoice_fx_rate.sql
--
-- R-045 slice 3 (7 Oct 2026) — a foreign-currency (USD…) invoice keeps the rate it was
-- issued at, and where that rate came from.
--
-- THE HOLE: invoices had no currency or rate. The invoice PDF read quotes.currency and
-- quotes.exchange_rate LIVE, so the "INR equivalent (for GST)" line on an issued invoice
-- followed any later edit of its quote, and nothing recorded whether the rate was the
-- RBI/FBIL reference rate (CGST Rule 34) or an indicative internet rate.
--
-- WHAT THIS DOES
--   1. quotes.fx_source / quotes.fx_date — the builder stamps where the rate came from
--      ('fbil' | 'er-api' | 'frankfurter' | 'manual') and the rate's own date.
--   2. invoices.currency / fx_rate / fx_source / fx_date.
--   3. BEFORE INSERT trigger: a new invoice on a FOREIGN-currency quote copies those four
--      from its quote when the creating path left them NULL — so generate_invoice,
--      create_direct_invoice, raise_subscription_billing, raise_project_milestone_invoice
--      and any future path are covered without copying their bodies here.
--      INR quotes leave all four NULL (= ₹ invoice, exactly as before).
--   4. BEFORE UPDATE freeze: once fx_rate is set the four may not change (null → value is
--      allowed) except under the existing maintenance escape hatch
--      `set local app.invoice_amend_reason = '<why>'`.
--
-- OLD INVOICES ARE NOT BACKFILLED. Their quote's rate today is not proof of the rate at
-- issue; the PDF keeps its previous fallback (the quote's currency/rate) for them.
-- Books stay in whole ₹ — nothing here changes an amount.
-- Test: supabase/tests/invoice_fx_rate.test.sql (begin ... rollback).

alter table public.quotes
  add column if not exists fx_source text,
  add column if not exists fx_date   date;

comment on column public.quotes.fx_source is 'R-045: where exchange_rate came from — fbil (RBI reference), er-api / frankfurter (indicative), manual (typed). NULL = before R-045 or INR.';
comment on column public.quotes.fx_date   is 'R-045: the date the exchange_rate is for (as given by its source; today for manual).';

alter table public.invoices
  add column if not exists currency  text,
  add column if not exists fx_rate   numeric,
  add column if not exists fx_source text,
  add column if not exists fx_date   date;

alter table public.invoices drop constraint if exists invoices_fx_rate_positive;
alter table public.invoices
  add constraint invoices_fx_rate_positive check (fx_rate is null or fx_rate > 0);
alter table public.invoices drop constraint if exists invoices_currency_iso;
alter table public.invoices
  add constraint invoices_currency_iso check (currency is null or currency ~ '^[A-Z]{3}$');

comment on column public.invoices.currency  is 'R-045: billing currency at issue (ISO). NULL = INR invoice (or issued before R-045).';
comment on column public.invoices.fx_rate   is 'R-045: INR per 1 unit of currency used at issue. GST is always in INR at this rate.';
comment on column public.invoices.fx_source is 'R-045: source of fx_rate — fbil | er-api | frankfurter | manual.';
comment on column public.invoices.fx_date   is 'R-045: date the fx_rate is for.';

-- ── 1. Snapshot from the quote at insert ────────────────────────────────────
create or replace function public.tg_invoice_fx_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare q record;
begin
  if new.quote_id is null or new.currency is not null then
    return new;
  end if;
  select upper(btrim(coalesce(qu.currency, ''))) as currency, qu.exchange_rate, qu.fx_source, qu.fx_date
    into q
    from public.quotes qu
   where qu.id = new.quote_id and qu.tenant_id = new.tenant_id;
  if not found or q.currency in ('', 'INR') or q.exchange_rate is null or q.exchange_rate <= 0 then
    return new;
  end if;
  new.currency  := q.currency;
  new.fx_rate   := coalesce(new.fx_rate,   q.exchange_rate);
  new.fx_source := coalesce(new.fx_source, q.fx_source);
  new.fx_date   := coalesce(new.fx_date,   q.fx_date);
  return new;
end $$;
revoke all on function public.tg_invoice_fx_snapshot() from public;

drop trigger if exists trg_invoice_fx_snapshot on public.invoices;
create trigger trg_invoice_fx_snapshot
  before insert on public.invoices
  for each row execute function public.tg_invoice_fx_snapshot();

-- ── 2. Freeze once set ──────────────────────────────────────────────────────
create or replace function public.tg_invoice_fx_freeze()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := nullif(btrim(coalesce(current_setting('app.invoice_amend_reason', true), '')), '');
begin
  if old.fx_rate is null then
    return new;
  end if;
  if new.currency  is distinct from old.currency
     or new.fx_rate   is distinct from old.fx_rate
     or new.fx_source is distinct from old.fx_source
     or new.fx_date   is distinct from old.fx_date then
    if v_reason is null then
      raise exception 'Invoice % was issued at 1 % = Rs % — its currency and exchange rate cannot be changed. Issue a credit note and a new invoice instead.',
        old.id, old.currency, old.fx_rate
        using errcode = 'check_violation';
    end if;
    raise notice '[invoices] % fx amended under app.invoice_amend_reason=%', old.id, v_reason;
  end if;
  return new;
end $$;
revoke all on function public.tg_invoice_fx_freeze() from public;

drop trigger if exists trg_invoice_fx_freeze on public.invoices;
create trigger trg_invoice_fx_freeze
  before update on public.invoices
  for each row execute function public.tg_invoice_fx_freeze();
