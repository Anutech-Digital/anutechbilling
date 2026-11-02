-- deploy-peek: to_regprocedure('public.set_invoice_external_number(text,text)') is not null and to_regprocedure('public.reconcile_bank_credit_new_sale(uuid,uuid,jsonb,boolean,date,date,integer,numeric,text,text,text)') is not null and to_regprocedure('public.reconcile_bank_credit_split(uuid,uuid,jsonb,jsonb,text,text)') is not null
-- 20261102061607_r2360_zoho_invoice_number_on_sale.sql
--
-- R-2360 (2 Nov 2026, Find in Zoho part 2, G-RECON): a sale booked from a bank credit after
-- "Find in Zoho" (R-2359) keeps the Zoho invoice number on the app invoice
-- (invoices.external_number — the column + unique (tenant_id, upper(external_number)) index
-- exist since R-1739's opening-invoice import, so no new index and no data risk here).
--
--   1. set_invoice_external_number(invoice, number): owner / manager / accountant / billing,
--      own company only. Refuses a number another invoice of the company already carries —
--      including an imported Zoho OPENING invoice (whose id is the Zoho number) — with
--      "Zoho invoice INV/… is already in the app as <app number>." The app calls it after it
--      raises the first part's invoice of a sale billed in parts.
--   2. reconcile_bank_credit_new_sale(…, p_external_number) and
--      reconcile_bank_credit_split(…, p_external_number): NEW overloads with one more, REQUIRED
--      argument. The old signatures stay exactly as they are (R-2026's deploy-peek checks the
--      10-argument one; a call without the number resolves only to the old one, so nothing is
--      ambiguous). Each wrapper books through the old function, then refuses a Zoho number that
--      is already in the app (the whole booking rolls back — nothing is saved) or stores it on
--      the sale's invoice. A sale billed in parts has no invoice yet: the duplicate check still
--      runs, the result says external_number_saved = false and the app saves it once the first
--      part's invoice is raised.
-- Test: supabase/tests/r2360_zoho_external_number.test.sql

begin;

-- ── helpers (internal) ─────────────────────────────────────────────────────────────────────
create or replace function public.zoho_external_number_clean(p_number text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare v text := nullif(btrim(coalesce(p_number, '')), '');
begin
  /* R-2360 */
  if v is not null and length(v) > 60 then
    raise exception 'The Zoho invoice number is too long (% characters — at most 60).', length(v) using errcode = '22023';
  end if;
  return v;
end;
$$;
revoke all on function public.zoho_external_number_clean(text) from public, anon;
grant execute on function public.zoho_external_number_clean(text) to authenticated, service_role;   -- pure trim + length check

/* Which app invoice of the company already IS this Zoho number: one carrying it as
   external_number, or an imported opening invoice whose id is the number (R-1739). */
create or replace function public.invoice_external_number_holder(p_tenant_id uuid, p_number text, p_except_invoice text default null)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select i.id
    from public.invoices i
   where i.tenant_id = p_tenant_id
     and (upper(btrim(i.external_number)) = upper(btrim(p_number))
          or (i.document_kind = 'opening_invoice' and upper(i.id) = upper(btrim(p_number))))
     and (p_except_invoice is null or i.id <> p_except_invoice)
   order by i.id
   limit 1
$$;
revoke all on function public.invoice_external_number_holder(uuid, text, text) from public, anon, authenticated;
grant execute on function public.invoice_external_number_holder(uuid, text, text) to service_role;

-- ── 1. set_invoice_external_number ─────────────────────────────────────────────────────────
create or replace function public.set_invoice_external_number(p_invoice_id text, p_external_number text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller  uuid;
  v_trusted boolean;
  v_num     text;
  v_inv     record;
  v_holder  text;
begin
  /* R-2360 */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can save a Zoho invoice number.' using errcode = '42501';
  end if;
  v_num := public.zoho_external_number_clean(p_external_number);
  if v_num is null then
    raise exception 'Give the Zoho invoice number to save.' using errcode = '22023';
  end if;

  select i.id, i.tenant_id, i.external_number into v_inv
    from public.invoices i
   where i.id = p_invoice_id and (v_caller is null or i.tenant_id = v_caller)
   for update;
  if not found then
    raise exception 'Invoice % was not found in your company.', p_invoice_id using errcode = 'no_data_found';
  end if;
  if v_inv.external_number is not null then
    if upper(btrim(v_inv.external_number)) = upper(v_num) then
      return jsonb_build_object('invoice_id', v_inv.id, 'external_number', v_inv.external_number, 'changed', false);
    end if;
    raise exception 'Invoice % already carries Zoho number %. Nothing was changed.', v_inv.id, v_inv.external_number
      using errcode = 'check_violation';
  end if;
  v_holder := public.invoice_external_number_holder(v_inv.tenant_id, v_num, v_inv.id);
  if v_holder is not null then
    raise exception 'Zoho invoice % is already in the app as %. Nothing was saved.', v_num, v_holder
      using errcode = 'unique_violation';
  end if;

  update public.invoices set external_number = v_num
   where id = v_inv.id and tenant_id = v_inv.tenant_id;
  return jsonb_build_object('invoice_id', v_inv.id, 'external_number', v_num, 'changed', true);
end;
$$;
revoke all on function public.set_invoice_external_number(text, text) from public, anon;
grant execute on function public.set_invoice_external_number(text, text) to authenticated, service_role;
comment on function public.set_invoice_external_number(text, text) is
  'R-2360: store the Zoho invoice number on an app invoice (invoices.external_number). Owner/manager/accountant/billing, own company only; refuses a number another invoice (or an imported opening invoice) already is.';

-- ── shared step of both wrappers ───────────────────────────────────────────────────────────
create or replace function public.bank_sale_keep_external_number(p_txn_id uuid, p_invoice_id text, p_number text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_holder text;
begin
  /* R-2360: after the booking, in the same transaction — a refusal rolls the booking back. */
  select t.tenant_id into v_tenant from public.bank_transactions t where t.id = p_txn_id;
  v_holder := public.invoice_external_number_holder(v_tenant, p_number, p_invoice_id);
  if v_holder is not null then
    raise exception 'Zoho invoice % is already in the app as %. Nothing was saved.', p_number, v_holder
      using errcode = 'unique_violation';
  end if;
  if p_invoice_id is null then
    return false;   -- billed in parts: the app saves it on the first part's invoice
  end if;
  perform public.set_invoice_external_number(p_invoice_id, p_number);
  return true;
end;
$$;
revoke all on function public.bank_sale_keep_external_number(uuid, text, text) from public, anon, authenticated;
grant execute on function public.bank_sale_keep_external_number(uuid, text, text) to service_role;

-- ── 2a. reconcile_bank_credit_new_sale + the Zoho number ───────────────────────────────────
create or replace function public.reconcile_bank_credit_new_sale(
  p_txn_id              uuid,
  p_customer_id         uuid,
  p_lines               jsonb,
  p_create_subscription boolean,
  p_sub_start           date,
  p_sub_renewal         date,
  p_tds_amount          integer,
  p_tds_rate_pct        numeric,
  p_tds_section         text,
  p_billing_cycle       text,
  p_external_number     text      -- R-2360: the Zoho invoice number (null = none)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_num   text;
  v_res   jsonb;
  v_saved boolean;
begin
  /* R-2360: the old 10-argument function books (all its guards); then the Zoho number. */
  v_num := public.zoho_external_number_clean(p_external_number);
  v_res := public.reconcile_bank_credit_new_sale(
             p_txn_id, p_customer_id, p_lines, p_create_subscription, p_sub_start, p_sub_renewal,
             p_tds_amount, p_tds_rate_pct, p_tds_section, p_billing_cycle);
  if v_num is null then
    return v_res;
  end if;
  v_saved := public.bank_sale_keep_external_number(p_txn_id, nullif(v_res->>'invoice_id', ''), v_num);
  return v_res || jsonb_build_object('external_number', v_num, 'external_number_saved', v_saved);
end;
$$;
revoke all on function public.reconcile_bank_credit_new_sale(uuid, uuid, jsonb, boolean, date, date, integer, numeric, text, text, text) from public, anon;
grant execute on function public.reconcile_bank_credit_new_sale(uuid, uuid, jsonb, boolean, date, date, integer, numeric, text, text, text) to authenticated, service_role;
comment on function public.reconcile_bank_credit_new_sale(uuid, uuid, jsonb, boolean, date, date, integer, numeric, text, text, text) is
  'R-2360: reconcile_bank_credit_new_sale + the Zoho invoice number from Find in Zoho, kept on the sale''s invoice (external_number); a number already in the app is refused and nothing is saved.';

-- ── 2b. reconcile_bank_credit_split + the Zoho number (for its new sale) ───────────────────
create or replace function public.reconcile_bank_credit_split(
  p_txn_id          uuid,
  p_customer_id     uuid,
  p_items           jsonb,
  p_sale            jsonb,
  p_rest            text,
  p_external_number text            -- R-2360: the Zoho invoice number of the NEW sale (null = none)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_num   text;
  v_res   jsonb;
  v_part  jsonb;
  v_inv   text := null;
  v_saved boolean;
begin
  /* R-2360 */
  v_num := public.zoho_external_number_clean(p_external_number);
  if v_num is not null and p_sale is null then
    raise exception 'A Zoho invoice number is kept only on a new sale. Add the sale, or clear the Zoho number.' using errcode = '22023';
  end if;
  v_res := public.reconcile_bank_credit_split(p_txn_id, p_customer_id, p_items, p_sale, p_rest);
  if v_num is null then
    return v_res;
  end if;
  for v_part in select value from jsonb_array_elements(coalesce(v_res->'parts', '[]'::jsonb)) loop
    if coalesce((v_part->>'new_quote')::boolean, false) then
      v_inv := nullif(v_part->>'invoice_id', '');
    end if;
  end loop;
  v_saved := public.bank_sale_keep_external_number(p_txn_id, v_inv, v_num);
  return v_res || jsonb_build_object('external_number', v_num, 'external_number_saved', v_saved);
end;
$$;
revoke all on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text, text) from public, anon;
grant execute on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text, text) to authenticated, service_role;
comment on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text, text) is
  'R-2360: reconcile_bank_credit_split + the Zoho invoice number of its new sale, kept on that sale''s invoice (external_number); a number already in the app is refused and nothing is saved.';

commit;
