-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.record_multi_invoice_payment(uuid,date,text,uuid,text,integer,jsonb,boolean,text)') and prosrc like '%R-2551%')
-- deploy-key: r2551tdsgrossmulti
--
-- R-2551 (7 Nov 2026, p1 money) — R-2538's other half. R-2538 made the TDS gross = the taxable value of the
-- PART a receipt pays on the bank-reconcile path (bank_credit_pay_item). record_multi_invoice_payment (the
-- Record payment sheet over one or more invoices, and the Zoho bulk-book) still wrote the WHOLE invoice's
-- taxable value as the gross on a part payment — a ₹5,900 part of an ₹11,800 invoice got a ₹10,000 gross,
-- so 26AS never matched — and with no rate given it saved nothing at all (rate_pct is NOT NULL).
--
-- ─── WHAT THIS CHANGES ──────────────────────────────────────────────────────────────────────────
--   record_multi_invoice_payment(...)  ← 20261105180900_r2501 (its latest body; checked all anutech/*
--   branches). Same signature, same grants (create or replace keeps them).
--   1. Each line's TDS gross = public.bank_credit_tds_gross(amount + TDS, taxable, GST-inclusive total,
--      TDS, rate) — R-2538's helper: the part's taxable, never above the taxable; a given rate the TDS
--      does not fit on the part → TDS × 100 ÷ rate (capped). Never null (0 with no taxable, as before).
--      Taxable and total from ONE document: the invoice's; an invoice with no taxable value and its own
--      quote → the quote's taxable (subtotal, else amount less GST) AND the quote's total (R-2538's rule).
--      An instalment invoice with no taxable → 0, as bank_credit_pay_item. An opening / Zoho invoice
--      with no taxable (opening invoices are imported with taxable 0) → 0 here, and
--      _record_opening_invoice_payment books the receipt amount as before (no tax split is known).
--      The line's own "tds_gross" (no caller sends one) is no longer read — the server rule decides.
--   2. No rate given → the rate is derived from that gross (TDS × 100 ÷ gross, 2 dp), as R-2538.
--      Still none (no taxable), or above 100% (TDS bigger than the part's taxable) → refused in words
--      ("enter the TDS rate"), never the bare NOT NULL error — except an opening / Zoho invoice, whose
--      own function works its rate out as before. Replay lines skip all of this (the retry answer).
--   Not changed: the desk Record payment sheet's own call (record_desk_payment) — its gross is now
--   computed in the app by tdsPartGross (src/lib/accounting/tds-receipt.ts), the same rule.
-- Test: supabase/tests/r2551_tds_gross_desk_multi.test.sql (begin … rollback; red without this file).

begin;

CREATE OR REPLACE FUNCTION public.record_multi_invoice_payment(p_customer_id uuid, p_received_on date, p_method text, p_bank_account_id uuid, p_reference text, p_received integer, p_allocations jsonb, p_excess_to_credit boolean DEFAULT true, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-1525: one receipt → several invoices of one customer, via record_desk_payment per line.
   R-1564: an instalment invoice (no quote of its own) goes through record_instalment_payment.
   R-1676: its lines share one UTR on purpose — app.payment_ref_batch lets them past
   trg_payments_ref_once for the loop only.
   R-1739: an imported Zoho opening invoice (no quote) is settled by _record_opening_invoice_payment.
   R-2501: so is an FY sale imported from Zoho (invoices.zoho_invoice_id — no quote either).
   R-2551: each line's TDS gross = the taxable value of the PART it pays (R-2538's bank_credit_tds_gross),
   taxable and total from one document; no rate given → derived from that gross. */
declare
  v_open       boolean;
  v_inst       boolean;
  v_inst_q     text[] := array[]::text[];
  v_tenant     uuid := public.current_tenant_id();
  v_trusted    boolean;
  v_n          integer;
  v_alloc      jsonb;
  v_ids        text[] := array[]::text[];
  v_inv        record;
  v_quote      record;
  v_received   integer;
  v_inv_due    integer;
  v_q_due      integer;
  v_due        integer;
  v_amt        numeric;
  v_tds        numeric;
  v_lines      jsonb := '[]'::jsonb;
  v_line       jsonb;
  v_sum        integer := 0;
  v_excess     integer;
  v_carrier    integer := null;
  v_replays    integer := 0;
  v_idx        integer;
  v_settle     integer;
  v_r          jsonb;
  v_out        jsonb := '[]'::jsonb;
  v_credit     integer;
  v_credit_inv text := null;
  v_notes      text;
  v_gross      integer;
  v_want       integer;
  v_taxable    integer;          -- R-2551: the taxable value the line's part is measured against
  v_total      integer;          -- R-2551: that document's GST-inclusive total
  v_rate       numeric;          -- R-2551: the rate recorded (given, else from the part's gross)
begin
  /* R-718 role gate — same as record_payment / record_desk_payment. */
  /* R-2501: public.current_request_role() in place of the raw auth.role() (R-2487 rule) — the same answer. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a payment. Ask one of them to record it.'
      using errcode = '42501';
  end if;
  /* §17c fail-closed: no company → nothing. */
  if v_tenant is null then
    raise exception 'No company context — sign in again, then record the payment.' using errcode = '28000';
  end if;

  if p_customer_id is null
     or not exists (select 1 from public.customers where id = p_customer_id and tenant_id = v_tenant) then
    raise exception 'That customer is not in your company. Open the customer from Customers and try again.'
      using errcode = '42501';
  end if;
  if p_received is null or p_received <= 0 then
    raise exception 'Enter the amount received (more than ₹0).';
  end if;
  if p_received_on is null then
    raise exception 'Enter the date the money was received.';
  end if;
  if p_method is null or p_method not in ('upi', 'razorpay', 'bank_transfer', 'cheque', 'cash', 'other') then
    raise exception 'Choose how the money came in (UPI, bank transfer, cheque, cash…).';
  end if;
  if p_reference is null or length(trim(p_reference)) = 0 then
    raise exception 'Enter a reference (UTR / cheque no. / receipt no.) so this payment can be matched later.';
  end if;
  if p_bank_account_id is not null
     and not exists (select 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant) then
    raise exception 'That bank account is not in your company. Choose one of your bank accounts.' using errcode = '42501';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Choose at least one invoice to apply this payment to.';
  end if;
  v_n := jsonb_array_length(p_allocations);
  if v_n > 200 then
    raise exception 'Too many invoices in one payment (% — at most 200). Record it in two parts.', v_n;
  end if;

  /* Shape + no duplicates, then lock every invoice in id order before reading any due. */
  for v_alloc in select value from jsonb_array_elements(p_allocations) loop
    if jsonb_typeof(v_alloc) <> 'object' or coalesce(v_alloc->>'invoice_id', '') = '' then
      raise exception 'Each line needs an invoice. Refresh the list and try again.';
    end if;
    if (v_alloc->>'invoice_id') = any(v_ids) then
      raise exception 'Invoice % is listed twice. Keep it once with the full amount.', v_alloc->>'invoice_id';
    end if;
    v_ids := v_ids || (v_alloc->>'invoice_id');
  end loop;
  perform 1 from public.invoices
   where id = any(v_ids) and tenant_id = v_tenant
   order by id
   for update;

  v_idx := 0;
  for v_alloc in select value from jsonb_array_elements(p_allocations) loop
    begin
      v_amt := coalesce((v_alloc->>'amount')::numeric, 0);
      v_tds := coalesce((v_alloc->>'tds_amount')::numeric, 0);
    exception when others then
      raise exception 'The amount for invoice % is not a number.', v_alloc->>'invoice_id';
    end;
    if v_amt <> trunc(v_amt) or v_tds <> trunc(v_tds) then
      raise exception 'Use whole rupees for invoice % (no paise).', v_alloc->>'invoice_id';
    end if;
    if v_amt < 0 or v_tds < 0 then
      raise exception 'The amount for invoice % cannot be negative.', v_alloc->>'invoice_id';
    end if;
    if v_amt + v_tds <= 0 then
      raise exception 'Invoice % has ₹0 against it. Enter an amount or remove the line.', v_alloc->>'invoice_id';
    end if;

    select i.id, i.tenant_id, i.customer_id, i.amount, i.net_payable, i.paid_amount, i.status,
           i.quote_id, i.taxable_value, i.document_kind, i.zoho_invoice_id
      into v_inv
      from public.invoices i
     where i.id = v_alloc->>'invoice_id' and i.tenant_id = v_tenant;
    if not found then
      raise exception 'Invoice % was not found in your company. Refresh the list and try again.', v_alloc->>'invoice_id'
        using errcode = '42501';
    end if;
    if v_inv.customer_id is distinct from p_customer_id then
      raise exception 'Invoice % belongs to another customer. Record its payment from that customer.', v_inv.id
        using errcode = '42501';
    end if;

    v_inst := false;
    v_open := v_inv.document_kind = 'opening_invoice' or v_inv.zoho_invoice_id is not null;   -- R-2501
    if v_open then
      select null::text as id, null::integer as amount, null::text as invoice_id,
             null::integer as subtotal, null::numeric as tax_rate into v_quote;   -- R-2551: + subtotal, tax_rate
    else
    select q.id, q.amount, q.invoice_id, q.subtotal, q.tax_rate   -- R-2551: + subtotal, tax_rate (TDS gross)
      into v_quote
      from public.quotes q
     where q.id = v_inv.quote_id and q.tenant_id = v_tenant and q.invoice_id = v_inv.id;
    if not found then
      /* R-1564: a subscription instalment — its money is recorded on the subscription's quote
         and applied to this invoice by record_instalment_payment. */
      select q.id, q.amount, q.invoice_id, q.subtotal, q.tax_rate
        into v_quote
        from public.subscription_billings b
        join public.subscriptions s on s.id = b.subscription_id and s.tenant_id = v_tenant
        join public.quotes q on q.id = s.quote_id and q.tenant_id = v_tenant and q.invoice_id is null
       where b.invoice_id = v_inv.id and b.tenant_id = v_tenant
       limit 1;
      if not found then
        raise exception 'Invoice % has no quote of its own (a project invoice). Record its payment from the project.', v_inv.id;
      end if;
      v_inst := true;
      /* Two instalments of one subscription share its quote, and quote + reference is the
         replay key — the second line would read as a retry of the first. */
      if v_quote.id = any(v_inst_q) then
        raise exception 'Invoice % is another instalment of the same subscription as an invoice above. Keep one instalment per subscription here, or record this receipt on the oldest instalment from the invoice page — what is over its due goes to the next instalment of that subscription.', v_inv.id;
      end if;
      v_inst_q := v_inst_q || v_quote.id;
    end if;
    end if;  -- R-1739 v_open

    /* Replay: this quote already holds a received payment with this reference. */
    if exists (select 1 from public.payments p
                where p.tenant_id = v_tenant
                  and case when v_open then p.quote_id is null and p.invoice_id = v_inv.id
                           else p.quote_id = v_quote.id end
                  and p.reference = p_reference and p.status = 'received') then
      v_replays := v_replays + 1;
      v_due := null;
    else
      if v_inv.status::text in ('paid', 'void') then
        v_inv_due := 0;
      else
        v_inv_due := greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - coalesce(v_inv.paid_amount, 0));
      end if;
      if v_inst or v_open then
        /* R-1564: an instalment owes its own due; the year's quote total is not the limit. */
        v_due := v_inv_due;
      else
        select coalesce(sum(amount), 0)::int into v_received
          from public.payments where quote_id = v_quote.id and tenant_id = v_tenant and status = 'received';
        v_q_due := greatest(0, coalesce(v_quote.amount, 0) - v_received);
        v_due := least(v_inv_due, v_q_due);
      end if;
      if v_amt + v_tds > v_due then
        raise exception 'Invoice % has only ₹% due, but ₹% is applied to it. Lower that line; the rest can stay as advance credit.',
          v_inv.id, v_due, (v_amt + v_tds)::int;
      end if;
    end if;

    /* R-2551: the TDS gross = the taxable value of the PART this line pays (R-2538's rule and helper).
       Taxable and total from ONE document: the invoice's; an invoice with no taxable value and a quote
       of its own → the quote's taxable AND total. Instalment / opening / Zoho with none → 0 (as
       bank_credit_pay_item). A given rate the TDS does not fit on the part → TDS × 100 ÷ rate. */
    v_gross := 0;
    v_rate  := null;
    if v_tds > 0 and v_due is not null then   -- a replay line (v_due null) keeps the retry answer
      begin
        v_rate := nullif(nullif(trim(coalesce(v_alloc->>'tds_rate_pct', '')), '')::numeric, 0);
      exception when others then
        raise exception 'The TDS rate for invoice % is not a number.', v_inv.id;
      end;
      if v_rate is not null and (v_rate < 0 or v_rate > 100) then
        raise exception 'The TDS rate for invoice % must be between 0 and 100%%.', v_inv.id;
      end if;
      v_taxable := nullif(v_inv.taxable_value, 0);
      v_total   := coalesce(nullif(v_inv.amount, 0), nullif(v_inv.net_payable, 0));
      if v_taxable is null and not v_inst and not v_open then
        v_taxable := coalesce(nullif(v_quote.subtotal, 0),
                              round(coalesce(v_quote.amount, 0) * 100.0 / (100 + coalesce(v_quote.tax_rate, 18)))::int);
        v_total   := nullif(v_quote.amount, 0);
      end if;
      v_gross := public.bank_credit_tds_gross(v_amt::int + v_tds::int, v_taxable, v_total, v_tds::int, v_rate);
      v_rate  := coalesce(v_rate, round(v_tds * 100.0 / nullif(v_gross, 0), 2));
      /* An opening / Zoho invoice with no taxable: _record_opening_invoice_payment works its rate out
         from the receipt, as before R-2551. Anything else needs a real rate. */
      if not v_open and v_rate is null then
        raise exception 'Invoice % has no taxable value to work the TDS rate out from. Enter the TDS rate for it.', v_inv.id
          using errcode = '22023';
      end if;
      if v_rate > 100 then
        raise exception 'The TDS on invoice % (₹%) is more than the taxable value this line pays (₹%). Enter the TDS rate the customer used.',
          v_inv.id, v_tds::int, v_gross using errcode = '22023';
      end if;
    end if;

    v_sum := v_sum + v_amt::int;
    v_lines := v_lines || jsonb_build_object(
      'invoice_id', v_inv.id, 'quote_id', v_quote.id, 'instalment', v_inst, 'opening', v_open,
      'amount', v_amt::int, 'tds_amount', v_tds::int, 'due', v_due,
      'tds_gross', v_gross,
      'tds_section', nullif(trim(coalesce(v_alloc->>'tds_section', '')), ''),
      'tds_rate_pct', v_rate,
      'customer_tan', nullif(trim(coalesce(v_alloc->>'customer_tan', '')), ''));
    /* The last line that pays its invoice IN FULL carries any excess. R-1564: never an
       instalment — record_instalment_payment keeps its excess for the next instalment,
       not as customer credit. */
    if v_due is not null and v_amt + v_tds = v_due and not v_inst and not v_open then
      v_carrier := v_idx;
    end if;
    v_idx := v_idx + 1;
  end loop;

  /* Whole retry → nothing new; partial retry → refused. */
  if v_replays = v_n then
    select coalesce(jsonb_agg(jsonb_build_object(
             'invoice_id', l->>'invoice_id', 'quote_id', l->>'quote_id', 'payment_id', p.id,
             'amount', p.amount, 'invoice_paid', null)), '[]'::jsonb)
      into v_out
      from jsonb_array_elements(v_lines) l
      join public.payments p
        on p.tenant_id = v_tenant
       and case when coalesce((l->>'opening')::boolean, false) then p.quote_id is null and p.invoice_id = l->>'invoice_id'
                else p.quote_id = l->>'quote_id' end
       and p.reference = p_reference and p.status = 'received';
    return jsonb_build_object('idempotent_replay', true, 'already_recorded', true,
                              'received', p_received, 'allocated', v_sum, 'excess_credit', 0,
                              'credit_invoice_id', null, 'lines', v_out);
  elsif v_replays > 0 then
    raise exception 'Reference % is already recorded on % of these invoices. Use the bank''s own reference for this payment, or leave those invoices out.',
      p_reference, v_replays;
  end if;

  v_excess := p_received - v_sum;
  if v_excess < 0 then
    raise exception 'The invoice lines add up to ₹% but only ₹% was received. Lower a line so they add up to the amount received.',
      v_sum, p_received;
  end if;
  if v_excess > 0 and not coalesce(p_excess_to_credit, false) then
    raise exception '₹% of the ₹% received is not applied to any invoice. Apply it to an invoice, or keep it as advance credit.',
      v_excess, p_received;
  end if;
  if v_excess > 0 and v_carrier is null then
    raise exception '₹% would be left as advance credit while every chosen invoice is still part-paid (a subscription instalment never carries it). Pay at least one regular invoice in full first (oldest first), then keep the rest as advance — or lower the amount received to what the invoices take.',
      v_excess;
  end if;

  v_notes := nullif(concat_ws(' · ',
               nullif(trim(coalesce(p_notes, '')), ''),
               'One payment of ₹' || p_received || ' across ' || v_n || ' invoice' || case when v_n = 1 then '' else 's' end || ' (ref ' || trim(p_reference) || ')'), '');

  /* R-1676: one transfer → several invoices is the one place a UTR may repeat — but only
     among THIS call's lines: the reference must not already be on an earlier payment. */
  perform public.assert_payment_ref_unused(v_tenant, p_method, p_reference);
  perform set_config('app.payment_ref_batch', coalesce(public.payment_ref_key(p_method, p_reference), ''), true);

  v_idx := 0;
  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_want   := case when v_idx = v_carrier then v_excess else 0 end;
    v_settle := (v_line->>'amount')::int + (v_line->>'tds_amount')::int + v_want;
    v_gross := (v_line->>'tds_gross')::int;

    if coalesce((v_line->>'opening')::boolean, false) then
      /* R-1739: an imported Zoho opening invoice — the payment carries the invoice, no quote. */
      v_r := public._record_opening_invoice_payment(
        v_tenant, v_line->>'invoice_id', v_settle, p_method, p_reference, v_notes,
        p_received_on, p_bank_account_id,
        (v_line->>'tds_amount')::int,
        case when (v_line->>'tds_amount')::int > 0 then v_gross else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then coalesce(v_line->>'tds_section', '194J') end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'tds_rate_pct')::numeric end,
        case when (v_line->>'tds_amount')::int > 0 then v_line->>'customer_tan' end,
        public.indian_fiscal_year(p_received_on));
    elsif coalesce((v_line->>'instalment')::boolean, false) then
      /* R-1564: same arguments, keyed by the instalment invoice. */
      v_r := public.record_instalment_payment(
        v_line->>'invoice_id', v_settle, p_method, p_reference, v_notes,
        null, 0, p_received_on, p_bank_account_id,
        (v_line->>'tds_amount')::int,
        case when (v_line->>'tds_amount')::int > 0 then v_gross else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'amount')::int else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then coalesce(v_line->>'tds_section', '194J') end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'tds_rate_pct')::numeric end,
        case when (v_line->>'tds_amount')::int > 0 then v_line->>'customer_tan' end,
        public.indian_fiscal_year(p_received_on));
      if not coalesce((v_r->>'already_recorded')::boolean, false)
         and not coalesce((v_r->>'idempotent_replay')::boolean, false)
         and coalesce((v_r->>'applied')::int, -1) <> v_settle then
        raise exception 'Amounts for invoice % are out of step (applied ₹%, expected ₹%). Nothing was saved — refresh the page and try again.',
          v_line->>'invoice_id', coalesce((v_r->>'applied')::int, 0), v_settle;
      end if;
    else
      v_r := public.record_desk_payment(
        v_line->>'quote_id', v_settle, p_method, p_reference, v_notes,
        null, 0, p_received_on, p_bank_account_id,
        (v_line->>'tds_amount')::int,
        case when (v_line->>'tds_amount')::int > 0 then v_gross else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'amount')::int else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then coalesce(v_line->>'tds_section', '194J') end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'tds_rate_pct')::numeric end,
        case when (v_line->>'tds_amount')::int > 0 then v_line->>'customer_tan' end,
        v_line->>'invoice_id',
        public.indian_fiscal_year(p_received_on));
    end if;

    if coalesce((v_r->>'already_recorded')::boolean, false)
       or coalesce((v_r->>'idempotent_replay')::boolean, false) then
      raise exception 'Invoice % already had this reference recorded a moment ago. Nothing was saved — refresh and check before trying again.',
        v_line->>'invoice_id';
    end if;
    v_credit := coalesce((v_r->>'overpaid_credit')::int, 0);
    if v_credit <> v_want then
      raise exception 'Amounts for invoice % are out of step (advance credit ₹%, expected ₹%). Nothing was saved — refresh the page and try again.',
        v_line->>'invoice_id', v_credit, v_want;
    end if;
    if v_idx = v_carrier and v_excess > 0 then
      v_credit_inv := v_line->>'invoice_id';
    end if;
    if (v_line->>'tds_amount')::int > 0 and not coalesce((v_r->>'tds_saved')::boolean, false) then
      raise exception 'The TDS for invoice % could not be saved. Nothing was saved — try again.', v_line->>'invoice_id';
    end if;

    v_out := v_out || jsonb_build_object(
      'invoice_id', v_line->>'invoice_id', 'quote_id', v_line->>'quote_id',
      'payment_id', v_r->>'payment_id', 'amount', v_settle,
      'tds_amount', (v_line->>'tds_amount')::int,
      'invoice_paid', coalesce((v_r->>'invoice_paid')::boolean, false));
    v_idx := v_idx + 1;
  end loop;
  perform set_config('app.payment_ref_batch', '', true);

  return jsonb_build_object(
    'idempotent_replay', false, 'already_recorded', false,
    'received', p_received, 'allocated', v_sum, 'excess_credit', v_excess,
    'credit_invoice_id', v_credit_inv, 'lines', v_out);
end;
$function$;

commit;
