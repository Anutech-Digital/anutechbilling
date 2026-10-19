-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_quote_export_customer_country')
-- deploy-key: r1677exportcountry
-- 20261019132621_r1677_export_customer_country.sql
--
-- R-1677 (19 Oct 2026, staging release check, story 11): a USD export quote for a US lead was
-- paid, and the customer record_payment made from the lead was saved as India — the lead
-- branch of record_payment (and accept_quote) never copies the lead's country, so customers
-- take the column default. "Invoice now" was then blocked ("no state on record") until someone
-- set United States by hand.
--
-- Fix without redefining record_payment / accept_quote (both are large and change often):
-- when a quote is FIRST linked to a customer, and the quote's place of supply is outside India
-- (the lead's country, else the typed prospect's), a customer that still carries no Indian
-- identity (country blank/India, no state, no GSTIN) takes that country. A customer with a
-- state or GSTIN is Indian on record and is never touched; an already-foreign one is left alone.
--
-- Invoker trigger function: runs as the caller (record_payment / accept_quote are definers),
-- touches only the quote's own tenant. Trigger functions need no EXECUTE grant.

create or replace function public.tg_quote_export_customer_country()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_country text;
begin
  if new.customer_id is null or old.customer_id is not null then
    return new;
  end if;

  if new.lead_id is not null then
    select nullif(btrim(l.country), '') into v_country
      from public.leads l
     where l.id = new.lead_id and l.tenant_id = new.tenant_id;
  end if;
  v_country := coalesce(v_country, nullif(btrim(new.prospect_country), ''));

  if v_country is null or lower(v_country) in ('india', 'in', 'ind', 'bharat') then
    return new;
  end if;

  update public.customers c
     set country = v_country
   where c.id = new.customer_id
     and c.tenant_id = new.tenant_id
     and lower(btrim(coalesce(c.country, ''))) in ('', 'india', 'in', 'ind', 'bharat')
     and nullif(btrim(coalesce(c.state_code, '')), '') is null
     and nullif(btrim(coalesce(c.gstin, '')), '') is null;

  return new;
end
$$;

drop trigger if exists trg_quote_export_customer_country on public.quotes;
create trigger trg_quote_export_customer_country
  after update of customer_id on public.quotes
  for each row
  execute function public.tg_quote_export_customer_country();
