-- deploy-peek: to_regprocedure('public.overseas_country_missing(text,text)') is not null and exists (select 1 from pg_trigger where tgname = 'trg_invoices_zz_a_overseas_country' and tgrelid = to_regclass('public.invoices')) and exists (select 1 from pg_trigger where tgname = 'trg_quotes_overseas_country' and tgrelid = to_regclass('public.quotes'))
-- deploy-key: r2620overseasneedscountry
--
-- R-2620 (9 Nov 2026, follow-up of R-2537): a customer marked Overseas but with NO country (or
-- country India) is read as India everywhere (money-rules G5 — empty country = domestic), so a NEW
-- quote / invoice to it was taxed as a domestic sale (18%) instead of a 0% export under the LUT —
-- silently. Staging Excel has such rows from the Zoho import (e.g. one design studio, 6 Nov).
--
-- DECISION (card R-2620 `decision`): refuse, never guess. The app cannot tell an export from an Indian
-- sale without the country, and both guesses are wrong tax (GST on a real export, or 0% on an Indian
-- buyer). One click on the customer fixes it.
--   1. overseas_country_missing(treatment, country) — TS twin overseasCountryMissing
--      (src/lib/gst/place-of-supply.ts). Overseas + a country that is empty or India.
--   2. Invoices: BEFORE INSERT, after the party snapshot (trigger name order: trg_invoice_snapshot_parties
--      < trg_invoices_zz_a_overseas_country < trg_invoices_zz_export_lut), a Tax Invoice whose frozen
--      treatment is Overseas and whose frozen country is not outside India is refused with the reason.
--      Every app path (generate_invoice, renewals, instalments, milestones, bank "new sale", direct
--      invoice) inserts through here. NOT refused: the Zoho FY sales import (party_from_source /
--      zoho_invoice_id / app.zoho_sale_import) and opening-invoice imports (import_batch_id) — they
--      record what was already filed; bills of supply (no GST head).
--   3. Quotes: a quote that goes out to the customer (status sent / viewed — on insert, or when it
--      leaves draft / rejected / expired) for such a customer is refused. A draft is allowed. Money
--      received ('accepted': record_payment, a bank "new sale") is never stopped here — its invoice is
--      held by 2. A quote already sent is never stopped later. Not refused: the Zoho FY receipts / sales
--      imports (app.zoho_fy_receipt_on / app.zoho_sale_import), a Bill of Supply business
--      (gst_registration unregistered / composition — no GST head).
-- NOT HERE: existing rows. Correcting a customer's country is a data repair (Pardeep's OK first); the
-- read-only report is production/scripts/ops/report-overseas-no-country.sql.

create or replace function public.overseas_country_missing(p_treatment text, p_country text)
returns boolean
language sql
immutable
set search_path = public
as $$
  /* R-2620. Empty country = India (G5), so Overseas with no country outside India cannot be taxed. */
  select coalesce(p_treatment = 'overseas', false)
         and not public.supply_is_zero_rated(p_country, null)
$$;
comment on function public.overseas_country_missing(text, text) is
  'R-2620: true when a customer is marked Overseas but has no country outside India — a new quote/invoice to it is refused. TS twin: overseasCountryMissing (src/lib/gst/place-of-supply.ts).';
revoke all on function public.overseas_country_missing(text, text) from public, anon;
grant execute on function public.overseas_country_missing(text, text) to authenticated, service_role;

create or replace function public.overseas_country_refusal(p_name text, p_country text, p_doc text)
returns text
language sql
immutable
set search_path = public
as $$
  /* R-2620: the one wording (invoice and quote). */
  select format('%s is marked Overseas but %s, so this %s would be taxed as an Indian sale. Open the customer, pick its country, then try again.',
                coalesce(nullif(btrim(p_name), ''), 'This customer'),
                case when nullif(btrim(coalesce(p_country, '')), '') is null then 'has no country on record'
                     else format('its country is %s', btrim(p_country)) end,
                p_doc)
$$;
revoke all on function public.overseas_country_refusal(text, text, text) from public, anon;
grant execute on function public.overseas_country_refusal(text, text, text) to authenticated, service_role;

-- ── Invoices ─────────────────────────────────────────────────────────────────────────────────
create or replace function public.tg_invoice_overseas_needs_country()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-2620. Runs after trg_invoice_document_kind and trg_invoice_snapshot_parties (name order), so
     document_kind, gst_treatment, customer_country and party_from_source are already set. */
  if new.customer_id is null
     or new.document_kind is distinct from 'tax_invoice'
     or new.party_from_source
     or new.zoho_invoice_id is not null
     or new.import_batch_id is not null
     or coalesce(current_setting('app.zoho_sale_import', true), '') = 'on' then
    return new;
  end if;
  if public.overseas_country_missing(new.gst_treatment, new.customer_country) then
    raise exception '%', public.overseas_country_refusal(new.customer_name, new.customer_country, 'invoice')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_invoice_overseas_needs_country() from public, anon, authenticated;

drop trigger if exists trg_invoices_zz_a_overseas_country on public.invoices;
create trigger trg_invoices_zz_a_overseas_country
  before insert on public.invoices
  for each row execute function public.tg_invoice_overseas_needs_country();

-- ── Quotes ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.tg_quote_overseas_needs_country()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
begin
  /* R-2620: only when the quote starts to reach the customer — a draft may wait for the country, and a
     quote already sent is never stopped later (payment, acceptance, the lead → customer link). */
  /* Only a quote that goes OUT to the customer (sent / viewed). 'accepted' = money received
     (record_payment, a bank "new sale") — booking received money is never stopped here; the
     invoice it leads to is held by the invoice trigger with the same reason. */
  if new.customer_id is null or new.status::text not in ('sent', 'viewed') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status::text in ('sent', 'viewed', 'accepted') then
    return new;
  end if;
  /* The Zoho FY imports record receipts / sales already made (advance quotes of the receipts import). */
  if coalesce(current_setting('app.zoho_sale_import', true), '') = 'on'
     or nullif(current_setting('app.zoho_fy_receipt_on', true), '') is not null then
    return new;
  end if;
  /* A Bill of Supply business (not GST-registered, or composition) charges no GST — no head to get wrong. */
  if exists (select 1 from public.tenants t
              where t.id = new.tenant_id and t.gst_registration in ('unregistered', 'composition')) then
    return new;
  end if;
  select cu.name, cu.country, cu.gst_treatment into c
    from public.customers cu
   where cu.id = new.customer_id and cu.tenant_id = new.tenant_id;
  if found and public.overseas_country_missing(c.gst_treatment, c.country) then
    raise exception '%', public.overseas_country_refusal(coalesce(c.name, new.customer_name), c.country, 'quote')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_quote_overseas_needs_country() from public, anon, authenticated;

drop trigger if exists trg_quotes_overseas_country on public.quotes;
create trigger trg_quotes_overseas_country
  before insert or update of status on public.quotes
  for each row execute function public.tg_quote_overseas_needs_country();
