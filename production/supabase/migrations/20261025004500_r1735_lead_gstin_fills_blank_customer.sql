-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'quotes_fill_customer_gstin_from_lead' and tgrelid = to_regclass('public.quotes'))
-- deploy-key: r1735leadgstinfill
-- 20261025004500_r1735_lead_gstin_fills_blank_customer.sql
--
-- R-1735 (25 Oct 2026) — a prospect's GSTIN must reach the invoice without being typed twice.
--
-- R-1712 put a GSTIN box on the quote builder's New prospect; it is saved on the prospect's lead,
-- and accept_quote / record_payment copy leads.gstin into the customer they CREATE. But when
-- they REUSE an existing customer (match_existing_customer: same email AND a matching name),
-- only a blank state was filled (R-373) — the lead's GSTIN was dropped, generate_invoice froze
-- an empty customer_gstin and the buyer got a B2C invoice (no input credit; fix = credit note
-- + a new invoice).
--
-- The fix is ONE rule in ONE place instead of a third copy of two very large RPC bodies: when a
-- quote raised on a lead is first linked to a customer (quotes.customer_id NULL → set — exactly
-- what accept_quote and record_payment do), a BLANK customers.gstin is filled from that lead's
-- GSTIN. Never overwrites a GSTIN already on file; copies only a 15-character GSTIN-shaped value
-- (the builder already checksum-checks it, prospect-contact.ts). Same tenant only. Runs inside
-- the caller's transaction, so it commits or rolls back with the accept / payment itself.
--
-- Proof: supabase/tests/r1735_lead_gstin_fill.test.sql (rolled back; includes a mutation check).

begin;

create or replace function public.fill_customer_gstin_from_lead()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.customers c
     set gstin = upper(btrim(l.gstin))
    from public.leads l
   where c.id = new.customer_id
     and c.tenant_id = new.tenant_id
     and l.id = new.lead_id
     and l.tenant_id = new.tenant_id
     and nullif(btrim(coalesce(c.gstin, '')), '') is null
     and upper(btrim(coalesce(l.gstin, ''))) ~ '^[0-9]{2}[A-Z0-9]{13}$';
  return null;
end;
$function$;

comment on function public.fill_customer_gstin_from_lead() is
  'R-1735: when a lead quote is first linked to a customer, fill a BLANK customers.gstin from the lead''s GSTIN (never overwrite).';

-- A trigger function only; nobody calls it directly.
revoke all on function public.fill_customer_gstin_from_lead() from public, anon, authenticated;

drop trigger if exists quotes_fill_customer_gstin_from_lead on public.quotes;
create trigger quotes_fill_customer_gstin_from_lead
  after update of customer_id on public.quotes
  for each row
  when (old.customer_id is null and new.customer_id is not null and new.lead_id is not null)
  execute function public.fill_customer_gstin_from_lead();

commit;
