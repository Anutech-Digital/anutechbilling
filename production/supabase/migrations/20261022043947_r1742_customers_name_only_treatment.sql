-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.customers_name_only()') and prosrc like '%R-1742%')
-- deploy-key: r1742nameonlytreatment
-- 20261022043947_r1742_customers_name_only_treatment.sql
--
-- R-1742 (22 Oct 2026). customers_name_only() — the picker list a sales / support / delivery
-- user gets for customers they may not read in full (R-1004) — now also returns the
-- customer's GST treatment (R-1736). Without it the sales user's quote builder treated an SEZ
-- customer in the seller's own state as CGST + SGST, while the invoice (trigger, real row)
-- charged IGST: the quote and the invoice disagreed on the tax head.
--
-- The treatment is a tax classification (Regular / SEZ / Overseas …), not contact data: the
-- function still returns no phone, email, GSTIN or address.
--
-- Started from the LATEST definition: 20261012023458_r1004_customer_reads.sql (the only one
-- on every anutech/* branch). Body unchanged except the new last column; the R-1004 marker
-- stays in the body because that migration's deploy-peek looks for it.
-- A new OUT column changes the return type, so the function is dropped and created again
-- (create or replace cannot do that); grants restated exactly as R-1004 set them.
-- Idempotent.

begin;

drop function if exists public.customers_name_only();

create function public.customers_name_only()
returns table (
  id uuid,
  name text,
  display_name text,
  customer_number text,
  state_code text,
  country text,
  has_gstin boolean,
  account_manager_id uuid,
  is_active boolean,
  gst_treatment text
)
language sql
stable
security definer
set search_path to ''
as $$
  /* R-1004: the customers a limited role may NOT read in full, by name only — so a picker
     still lists them. Never phone, email, GSTIN or address. Empty for full-read roles.
     R-1742: plus the GST treatment, so the quote builder applies the SEZ rule (IGST). */
  select c.id, c.name, c.display_name, c.customer_number,
         coalesce(nullif(btrim(c.state_code), ''),
                  case when c.gstin ~ '^[0-9]{2}' then left(c.gstin, 2) end),
         c.country,
         nullif(btrim(coalesce(c.gstin, '')), '') is not null,
         c.account_manager_id,
         c.is_active,
         c.gst_treatment
    from public.customers c
   where c.tenant_id = public.current_tenant_id()
     and public.current_user_has_role('sales', 'sales_senior', 'support', 'delivery')
     and not (c.id = any (public.my_customer_ids()))
     and (c.account_manager_id is null
          or not public.current_user_has_role('sales', 'sales_senior'))
   order by c.name, c.id
$$;

revoke all on function public.customers_name_only() from public, anon;
grant execute on function public.customers_name_only() to authenticated, service_role;

commit;
