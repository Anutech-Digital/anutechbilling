-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.record_payment_with_tds(text,integer,text,text,text,integer,integer,integer,text,numeric,text,text,text)') and prosrc like '%R-2045%')
-- deploy-key: r2045partrequesttds
-- 20261028082218_r2045_part_request_tds.sql
--
-- R-2045 (28 Oct 2026, Pardeep): a part payment request (R-2044, quotes.subscription_billing_id)
-- paid net of TDS — "Advance payment for Q2", bank ₹4,406 + TDS ₹408 (194J 10% on the ₹4,080
-- taxable) on a ₹4,814 part — is FULLY paid, and its TDS is a TDS receivable on THAT part's tax
-- invoice, the same as a TDS receipt on an invoice (record_instalment_payment passes the invoice).
--
-- Found (supabase/tests/r2045_part_request_tds.test.sql, red before this file): the Record
-- payment sheet and bank reconcile already send bank + TDS as the payment amount, so
-- tg_payments_part_request_invoice saw the part paid and raised its tax invoice for the full
-- amount, status Paid (instalment_credit counts the same payment amount, so bank + TDS). But the
-- TDS receivable row was written with invoice_id NULL: the part's invoice did not exist yet when
-- the sheet opened, so p_invoice_id was empty. A TDS credit that names no invoice cannot be matched
-- to the customer's Form 16A / 26AS line for that invoice.
--
-- Now record_payment_with_tds, when no invoice is passed and the quote is a part request, writes
-- the invoice the payment just raised (quotes.invoice_id, set by the trigger inside
-- record_payment). Ordinary quotes are unchanged (p_invoice_id as before). No new money RPC;
-- record_desk_payment and reconcile_bank_credit_to_item reach this through their existing calls.
-- TDS amount itself is what the caller sends; "more TDS than rate × this part's taxable value"
-- is a warning in the Record payment sheet (lib/billing/part-requests.ts), never a block.
-- Body: 20261024085113 (R-1828), the latest definition. Only v_inv_id is new.

begin;

CREATE OR REPLACE FUNCTION public.record_payment_with_tds(p_quote_id text, p_amount integer, p_method text, p_reference text, p_notes text DEFAULT NULL::text, p_tds_amount integer DEFAULT 0, p_tds_gross integer DEFAULT 0, p_tds_net_paid integer DEFAULT 0, p_tds_section text DEFAULT NULL::text, p_tds_rate_pct numeric DEFAULT NULL::numeric, p_customer_tan text DEFAULT NULL::text, p_invoice_id text DEFAULT NULL::text, p_fiscal_year text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result    jsonb;
  v_replay    boolean;
  v_pay_id    uuid;
  v_tenant    uuid;
  v_cust      uuid;
  v_cust_name text;
  v_tds_saved boolean := false;
  v_inv_id    text := p_invoice_id;
begin
  v_result := public.record_payment(p_quote_id, p_amount, p_method, p_reference, p_notes);

  v_replay := coalesce((v_result->>'already_recorded')::boolean, false)
           or coalesce((v_result->>'idempotent_replay')::boolean, false);
  v_pay_id := nullif(v_result->>'payment_id', '')::uuid;

  if not v_replay and coalesce(p_tds_amount, 0) > 0 then
    select tenant_id, customer_name into v_tenant, v_cust_name
      from public.quotes where id = p_quote_id;
    v_cust := nullif(v_result->>'customer_id', '')::uuid;

    /* R-2045: a part payment request has no invoice when it is paid — paying it in full
       (bank + TDS) raised that part's tax invoice just now (tg_payments_part_request_invoice →
       quotes.invoice_id). The TDS is withheld on THAT invoice. */
    if v_inv_id is null then
      select q.invoice_id into v_inv_id
        from public.quotes q
       where q.id = p_quote_id and q.subscription_billing_id is not null;
    end if;

    insert into public.tds_receivable (
      id, tenant_id, invoice_id, payment_id, customer_id, customer_name,
      customer_tan, section, rate_pct, gross_amount, tds_amount, net_paid,
      fiscal_year, payment_received_date, status, notes
    ) values (
      'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10)),
      v_tenant, v_inv_id, v_pay_id, v_cust, coalesce(v_cust_name, ''),
      nullif(trim(p_customer_tan), ''), coalesce(p_tds_section, '194J'), p_tds_rate_pct,
      p_tds_gross, p_tds_amount, p_tds_net_paid,
      coalesce(p_fiscal_year, public.indian_fiscal_year(public.ist_today())),
      public.ist_today(), 'pending_cert',
      'Auto-created atomically with payment ' || coalesce(v_pay_id::text, '?') || ' on quote ' || p_quote_id
    );
    v_tds_saved := true;
  end if;

  return v_result || jsonb_build_object('tds_saved', v_tds_saved);
end;
$function$;

commit;
