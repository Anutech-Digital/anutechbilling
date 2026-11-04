-- deploy-peek: to_regprocedure('public.network_seller_document_status(text[])') is not null
-- deploy-key: r2450networksellerstatus
-- 20261104015448_r2450_network_seller_status.sql
--
-- R-2450 (goal G-NETWORK, slice N2c, 4 Nov 2026): the SELLER sees its customer's answer — Pending /
-- Accepted by customer / Rejected by customer: <reason> / Cancelled — on its own invoice page (the
-- invoice and the credit / debit notes on it) and as a chip in the invoices list.
--
-- R-2434's network_seller_documents(text) reads one invoice (or all) for owner / manager /
-- accountant. The screens need two more things, so this adds ONE read-only function next to it
-- (R-2434's function is left as it is — R-2449 builds on that migration right now):
--   * a page of invoice ids in one call (the list shows 50 – 200 rows; one call per row would be
--     200 round trips) — capped at 500 ids;
--   * the billing role: billing issues and reads invoices (MONEY_RECORD_ROLES, 197 invoice-side
--     functions gate owner / manager / accountant / billing), so it must see the answer too.
--
-- Rules kept: SECURITY DEFINER + search_path; current_tenant_id() gate (only MY sent copies —
-- another company passing my invoice ids reads nothing); role gate; read-only (stable); no grant
-- to anon. A customer that is not on the network has no row, so the screen shows no badge.
--
-- Test: supabase/tests/r2450_network_seller_status.test.sql (rolled back; red without this file).

begin;

create or replace function public.network_seller_document_status(p_invoice_ids text[])
returns table (
  id uuid, kind text, seller_invoice_id text, seller_note_id text, doc_number text,
  buyer_name text, buyer_gstin text, status text, reject_reason text, responded_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2450: the seller's owner / manager / accountant / billing read what their customers answered
     on a page of their own invoices (the invoice copy and its credit / debit note copies). */
  v_t uuid := public.current_tenant_id();
begin
  if p_invoice_ids is null or cardinality(p_invoice_ids) = 0 then
    return;
  end if;
  if cardinality(p_invoice_ids) > 500 then
    raise exception 'Too many invoices in one read (%) — ask for at most 500 at a time.', cardinality(p_invoice_ids)
      using errcode = '22023';
  end if;
  if v_t is null or not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    return;
  end if;
  return query
  select d.id, d.kind, d.seller_invoice_id, d.seller_note_id, d.doc_number,
         b.name::text, d.buyer_gstin, d.status, d.reject_reason, d.responded_at, d.created_at
    from public.network_documents d
    join public.tenants b on b.id = d.buyer_tenant_id
   where d.seller_tenant_id = v_t
     and d.seller_invoice_id = any (p_invoice_ids)
   order by d.created_at desc;
end $function$;

revoke all on function public.network_seller_document_status(text[]) from public, anon;
grant execute on function public.network_seller_document_status(text[]) to authenticated;

commit;
