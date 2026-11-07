-- deploy-peek: to_regprocedure('public.bank_sale_undo_preview(uuid)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_credit_pay_item(uuid,integer,text,text,text,integer,numeric,text,boolean,date,date)') and prosrc like '%R-2179%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.unreconcile_bank_receipt(uuid,boolean)') and prosrc like '%R-2179%')
-- deploy-key: r2179reconcilegaps
--
-- R-2179 (7 Nov 2026, p1 money, G-RECON) — gaps from the August reconcile run on staging (build d7c3556).
--
-- ─── WHAT THIS CHANGES ──────────────────────────────────────────────────────────────────────────
--   1. bank_credit_pay_item  ← 20261107074500_r2538 (its latest body). Same signature and grants.
--      An ADD-SEATS or RENEWAL quote of a subscription billed yearly, paid from a bank line, is invoiced
--      on its FIRST receipt even when part-paid (R-2095's rule for new sales). Was: only when paid in full,
--      so a +2-seat quote left with a small balance had no GST invoice. The invoice is for the whole quote
--      on the receipt date with the balance due; the next receipt settles it (no second invoice). TDS
--      counts as paid (unchanged). A subscription billed in parts keeps its own part invoices (R-2044/R-808).
--   2. _bank_sale_undo_scope / bank_sale_undo_preview (new): what "Undo this sale too" takes back for a
--      line booked through "A new sale" (quotes.invoice_on_receipt) — receipt, invoice, quote, the
--      subscriptions it made, its TDS — and what stops it (another receipt, a credit/debit note, a TDS
--      already reported, a subscription that billed another invoice, a later live quote on one of them),
--      with the page to fix it on. The confirm dialog reads the preview.
--   3. unreconcile_bank_receipt  ← 20261101131404_r1997 (its latest body). "Undo the sale" now also takes
--      back an "A new sale" booking: its TDS row (pending_cert) removed, the receipt removed (voucher kept
--      as cancelled — as before), the invoice credit-noted in full (a draft voided — as before), the quote
--      rejected, and every subscription the sale made cancelled with its unbilled parts removed. Was:
--      refused ("recorded separately") — only the old "Invoice banao & reconcile" sale could be undone,
--      so the customer's quote, invoice and subscriptions stayed. Roles unchanged (owner / accountant).
--   Not changed: the customer stays (it may have other business); undoing a seat-add / renewal receipt;
--   the expense-reversal pairing (R-2204).
-- Test: supabase/tests/r2179_reconcile_gaps.test.sql (begin … rollback; red without this file).

begin;

-- ── 1. bank_credit_pay_item (from 20261107074500_r2538_tds_gross_part_paid — its latest body) ─────
create or replace function public.bank_credit_pay_item(
  p_txn_id              uuid,
  p_amount              integer,
  p_reference           text,
  p_quote_id            text    default null,
  p_invoice_id          text    default null,
  p_tds_amount          integer default 0,
  p_tds_rate_pct        numeric default null,
  p_tds_section         text    default null,
  p_create_subscription boolean default null,
  p_sub_start           date    default null,
  p_sub_renewal         date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2095 (Sept reconcile): a sale booked from a bank receipt (quotes.invoice_on_receipt) is invoiced on
   its FIRST receipt, part-paid or not; a split-billed sale's renewal date is the end of the commitment.
   R-2098: one item paid from a bank credit — no line lock, no reconcile (the caller does both).
   Called by reconcile_bank_credit_to_item (amount = the whole credit) and
   reconcile_bank_credit_split (amount = the item's share).
   R-2466: an imported Zoho opening invoice (no quote) → _record_opening_invoice_payment.
   R-2542: so is an FY sale imported from Zoho (invoices.zoho_invoice_id) — R-2501's rule; its TDS is
   on the invoice's taxable value (the quote path's rule), not on the GST-inclusive receipt.
   R-2538: the TDS gross is the taxable value of the PART this receipt pays (money + TDS, less GST),
   on every path; the rate, when none is given, follows that gross; a Zoho/opening replay must match
   the amount too; a written-off invoice is refused.
   R-2179: an ADD-SEATS or RENEWAL quote of a subscription billed yearly is invoiced on its first bank
   receipt too, part-paid or not (August: a +2-seat quote left with a small balance had no invoice) —
   the seats / the new term are live, so the tax invoice is for the whole supply with the balance due. */
declare
  v_txn        record;
  v_inv        record;
  v_quote      record;
  v_quote_id   text;
  v_kind       text;
  v_sub_id     uuid;
  v_new_sale   boolean := false;
  v_skip_sub   boolean := false;
  v_res        jsonb;
  v_pay_id     uuid;
  v_replay     boolean;
  v_tds        integer := greatest(0, coalesce(p_tds_amount, 0));
  v_gross      integer;
  v_inv_issued text := null;
  v_inv_now    text;
  v_lines      jsonb;
  v_inv_taxable integer := null;
  v_note       text;
  v_due        integer;
  v_left       integer;
  v_total      integer;          -- R-2538: the document's GST-inclusive total the part is measured against
  v_rate       numeric;          -- R-2538: the rate recorded (given, else from the part's gross)
  v_prev       record;           -- R-2538: a receipt with the line's reference but another amount
begin
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'Each item needs an amount of more than ₹0.' using errcode = '22023';
  end if;
  if (p_quote_id is null) = (p_invoice_id is null) then
    raise exception 'Pick one quote or one invoice this money is for.' using errcode = '22023';
  end if;
  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;

  /* What the money is for. */
  if p_invoice_id is not null then
    select i.id, i.tenant_id, i.quote_id, i.taxable_value, i.status, i.document_kind, i.zoho_invoice_id,
           i.amount, i.net_payable, i.paid_amount, i.written_off_at into v_inv
      from public.invoices i where i.id = p_invoice_id;
    if not found or v_inv.tenant_id is distinct from v_txn.tenant_id then
      raise exception 'Invoice % not found in your company', p_invoice_id using errcode = 'no_data_found';
    end if;
    /* R-2538 (R-2542 review #3): a written-off invoice takes no NEW money — reverse the write-off first.
       A line freed with its receipt kept (this reference already received on the invoice) still goes
       back to that receipt (the replays below). */
    if v_inv.written_off_at is not null
       and not exists (select 1 from public.payments p
                        where p.tenant_id = v_txn.tenant_id and p.invoice_id = p_invoice_id
                          and p.reference = p_reference and p.status = 'received') then
      raise exception 'Invoice % was written off on %, so it cannot take a receipt. Reverse the write-off first.',
        p_invoice_id, to_char(v_inv.written_off_at, 'DD Mon YYYY') using errcode = 'check_violation';
    end if;
    v_total := coalesce(nullif(v_inv.amount, 0), nullif(v_inv.net_payable, 0));
    /* R-2542: a quote-less receipt on a PAID invoice is checked after its replay (below) — a line
       un-reconciled (receipt kept) from an invoice it paid in full is matched back to that receipt,
       not refused. A void / draft invoice is refused here, replay or not. */
    if v_inv.status not in ('pending', 'overdue')
       and not (v_inv.status = 'paid'
                and (v_inv.document_kind = 'opening_invoice' or v_inv.zoho_invoice_id is not null) and v_inv.quote_id is null) then
      raise exception 'Invoice % is %, so there is nothing left to pay on it.', p_invoice_id, v_inv.status using errcode = 'check_violation';
    end if;

    /* R-2466: an imported Zoho opening invoice — its receipt carries the invoice, no quote.
       R-2542: an FY sale imported from Zoho too. */
    if (v_inv.document_kind = 'opening_invoice' or v_inv.zoho_invoice_id is not null) and v_inv.quote_id is null then
      select i.id, i.tenant_id, i.status, i.amount, i.net_payable, i.paid_amount, i.taxable_value into v_inv
        from public.invoices i where i.id = p_invoice_id and i.tenant_id = v_txn.tenant_id for update;
      v_note := 'Bank credit of ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ' matched to ' || p_invoice_id;
      v_due := greatest(0, coalesce(v_inv.net_payable, v_inv.amount, 0) - coalesce(v_inv.paid_amount, 0))::int;

      /* The same receipt again (this reference already on it, for the SAME money): that receipt — booked
         once. R-2538 (R-2542 review #2): the same reference for another amount is neither matched to the
         old receipt nor booked twice — refused, the operator looks at it. */
      select p.id, p.receipt_voucher_no into v_quote
        from public.payments p
       where p.tenant_id = v_txn.tenant_id and p.invoice_id = p_invoice_id and p.quote_id is null
         and p.reference = p_reference and p.status = 'received'
         and (p.amount = p_amount + v_tds   -- the same money, or the same bank money with the TDS it was booked with
              or p.amount - coalesce((select sum(t.tds_amount) from public.tds_receivable t
                                       where t.tenant_id = p.tenant_id and t.payment_id = p.id), 0) = p_amount)
       order by p.received_at limit 1;
      if not found then
        select p.amount, p.receipt_voucher_no into v_prev
          from public.payments p
         where p.tenant_id = v_txn.tenant_id and p.invoice_id = p_invoice_id and p.quote_id is null
           and p.reference = p_reference and p.status = 'received'
         order by p.received_at limit 1;
        if found then
          raise exception 'Invoice % already has receipt % of ₹% with reference %, but this line is ₹%. Check the line — nothing was saved.',
            p_invoice_id, coalesce(v_prev.receipt_voucher_no, '?'), to_char(v_prev.amount, 'FM999,999,999'), p_reference,
            to_char(p_amount + v_tds, 'FM999,999,999') using errcode = 'unique_violation';
        end if;
      else
        return jsonb_build_object(
          'kind', 'opening', 'quote_id', null, 'sub_id', null, 'skip_sub', false,
          'invoice_issued', null, 'payment_id', v_quote.id, 'replay', true,
          'res', jsonb_build_object('payment_id', v_quote.id, 'receipt_voucher_no', v_quote.receipt_voucher_no,
                                    'outstanding', v_due, 'is_fully_paid', v_due = 0, 'overpaid_credit', 0,
                                    'already_recorded', true));
      end if;

      if v_inv.status not in ('pending', 'overdue') then
        raise exception 'Invoice % is %, so there is nothing left to pay on it.', p_invoice_id, v_inv.status using errcode = 'check_violation';
      end if;

      if p_amount + v_tds > v_due then
        raise exception 'Invoice % (imported from Zoho) has only ₹% due, but ₹% is applied to it. Pay it with "Several quotes / invoices" and keep the rest as advance.',
          p_invoice_id, v_due, p_amount + v_tds using errcode = 'check_violation';
      end if;

      /* R-2538: TDS gross = the taxable value of the PART this receipt pays (R-2542 had the whole invoice). */
      v_gross := public.bank_credit_tds_gross(p_amount + v_tds, nullif(v_inv.taxable_value, 0), v_total, v_tds, p_tds_rate_pct);
      v_rate  := case when v_tds > 0 then coalesce(p_tds_rate_pct, round(v_tds * 100.0 / nullif(v_gross, 0), 2)) end;
      v_res := public._record_opening_invoice_payment(
        v_txn.tenant_id, p_invoice_id, p_amount + v_tds, 'bank_transfer', p_reference, v_note,
        v_txn.txn_date, v_txn.bank_account_id,
        v_tds, case when v_tds > 0 then coalesce(v_gross, 0) else 0 end,
        case when v_tds > 0 then coalesce(p_tds_section, '194J') end, v_rate,
        null, public.indian_fiscal_year(v_txn.txn_date));
      v_pay_id := nullif(v_res->>'payment_id', '')::uuid;
      if v_pay_id is null then
        raise exception 'The payment was not recorded.' using errcode = 'P0001';
      end if;
      if v_tds > 0 and not coalesce((v_res->>'tds_saved')::boolean, false) then
        raise exception 'The TDS for invoice % could not be saved. Nothing was saved — try again.', p_invoice_id using errcode = 'P0001';
      end if;
      v_left := v_due - (p_amount + v_tds);
      return jsonb_build_object(
        'kind', 'opening', 'quote_id', null, 'sub_id', null, 'skip_sub', false,
        'invoice_issued', null, 'payment_id', v_pay_id, 'replay', false,
        'res', v_res || jsonb_build_object('outstanding', v_left, 'is_fully_paid', v_left = 0));
    end if;

    v_quote_id := v_inv.quote_id;
    v_inv_taxable := nullif(v_inv.taxable_value, 0);
    if v_quote_id is null then
      select b.subscription_id into v_sub_id from public.subscription_billings b
       where b.tenant_id = v_txn.tenant_id and b.invoice_id = p_invoice_id limit 1;
      if v_sub_id is null then
        raise exception 'Invoice % has no quote or subscription behind it — record its payment from the invoice page.', p_invoice_id
          using errcode = 'check_violation';
      end if;
      v_kind := 'instalment';
    end if;
  else
    v_quote_id := p_quote_id;
  end if;

  if v_quote_id is not null then
    select q.* into v_quote from public.quotes q where q.id = v_quote_id for update;
    if not found or v_quote.tenant_id is distinct from v_txn.tenant_id then
      raise exception 'Quote % not found in your company', v_quote_id using errcode = 'no_data_found';
    end if;
    v_sub_id := coalesce(
      (select s.id from public.subscriptions s where s.tenant_id = v_quote.tenant_id and s.renewal_quote_id = v_quote.id limit 1),
      v_quote.renewal_subscription_id, v_quote.add_seats_subscription_id);
    v_kind := case
                when v_quote.is_add_seats then 'add_seats'
                when v_sub_id is not null or v_quote.is_renewal or v_quote.is_extension then 'renewal'
                when v_quote.is_one_off then 'one_off'
                else 'new' end;
    /* R-2538: the part's taxable, not the whole quote's. v_total: the invoice's total when the money is for
       an invoice, else the quote's — Suresh's half-yearly sale: ₹92,925 of ₹1,85,850 → gross ₹78,750. */
    /* Taxable and total from the SAME document: an invoice with no taxable value falls back to the quote's
       taxable AND the quote's total (never the whole year's taxable against one part's total). */
    v_total := case when v_inv_taxable is not null then v_total else nullif(v_quote.amount, 0) end;
    v_gross := public.bank_credit_tds_gross(
      p_amount + v_tds,
      coalesce(v_inv_taxable, nullif(v_quote.subtotal, 0), round(coalesce(v_quote.amount, 0) * 100.0 / (100 + coalesce(v_quote.tax_rate, 18)))::int),
      v_total, v_tds, p_tds_rate_pct);

    /* A new subscription sale that has filed nothing yet: the operator's subscription choice. */
    v_new_sale := v_kind = 'new'
      and not exists (select 1 from public.subscriptions s where s.tenant_id = v_quote.tenant_id and s.quote_id = v_quote.id)
      and not exists (select 1 from public.payments p where p.quote_id = v_quote.id and p.status = 'received')
      and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
                   where jsonb_typeof(li) = 'object' and public.quote_line_is_subscription(li, v_quote.tenant_id, false));
    if v_new_sale and p_create_subscription is false then
      /* record_payment's own 0157 guard: a one-off quote files no subscription. */
      update public.quotes set is_one_off = true where id = v_quote.id;
      v_skip_sub := true;
    elsif v_new_sale and (p_sub_start is not null or p_sub_renewal is not null) then
      if p_sub_start is not null and p_sub_renewal is not null and p_sub_renewal <= p_sub_start then
        raise exception 'The renewal date (%) must be after the start date (%).', p_sub_renewal, p_sub_start using errcode = '22023';
      end if;
      /* R-2095: billed in parts on a 1-year commitment — the renewal date is the END of the year,
         never the next part's date. Staging: renewal 19 Dec 2026 on a half-yearly sale from 19 Jun
         made the schedule count the year back from it (term start 20 Dec 2025), so the "next half"
         request covered the paid half again. */
      if p_sub_renewal is not null
         and coalesce(v_quote.billing_cycle, 'yearly') in ('monthly', 'quarterly', 'half_yearly')
         and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
                      where jsonb_typeof(li) = 'object' and li->>'commitment' = 'annual_yearly')
         and p_sub_renewal < (coalesce(p_sub_start, v_txn.txn_date) + interval '12 months' - interval '1 day')::date then
        raise exception 'Billed % on a 1-year commitment: the renewal date is the end of the year (%), not the next part''s date. The next part is billed on its own date.',
          replace(v_quote.billing_cycle, '_', '-'), to_char(coalesce(p_sub_start, v_txn.txn_date) + interval '12 months', 'FMDD Mon YYYY')
          using errcode = '22023';
      end if;
      select jsonb_agg(
               case when jsonb_typeof(li) = 'object' and public.quote_line_is_subscription(li, v_quote.tenant_id, false)
                    then li
                         || case when p_sub_start   is not null then jsonb_build_object('start_date',   p_sub_start::text)   else '{}'::jsonb end
                         || case when p_sub_renewal is not null then jsonb_build_object('renewal_date', p_sub_renewal::text) else '{}'::jsonb end
                    else li end
               order by ord)
        into v_lines
        from jsonb_array_elements(v_quote.line_items) with ordinality as t(li, ord);
      update public.quotes set line_items = v_lines where id = v_quote.id;
    end if;
  else
    v_gross := public.bank_credit_tds_gross(p_amount + v_tds, v_inv_taxable, v_total, v_tds, p_tds_rate_pct);   -- R-2538: the part's taxable (0 when none, as R-2542)
  end if;
  v_rate := case when v_tds > 0 then coalesce(p_tds_rate_pct, round(v_tds * 100.0 / nullif(v_gross, 0), 2)) end;   -- R-2538

  /* NOT 'Reconciled from bank receipt': that note marks a throw-away one-off sale which
     unreconcile_bank_receipt may delete ("undo the sale"). A renewal / add-seats / subscription
     payment must never be deleted from the bank page — un-reconciling only frees the line. */
  v_note := 'Bank credit of ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ' matched to ' || coalesce(p_invoice_id, v_quote_id);

  if v_kind = 'instalment' then
    v_res := public.record_instalment_payment(
      p_invoice_id, p_amount + v_tds, 'bank_transfer', p_reference, v_note,
      null, 0, v_txn.txn_date, v_txn.bank_account_id,
      v_tds, case when v_tds > 0 then v_gross else 0 end, case when v_tds > 0 then p_amount else 0 end,
      case when v_tds > 0 then coalesce(p_tds_section, '194J') end, v_rate,
      null, case when v_tds > 0 then public.indian_fiscal_year(v_txn.txn_date) end);
  else
    v_res := public.record_desk_payment(
      v_quote_id, p_amount + v_tds, 'bank_transfer', p_reference, v_note,
      null, 0, v_txn.txn_date, v_txn.bank_account_id,
      v_tds, case when v_tds > 0 then v_gross else 0 end, case when v_tds > 0 then p_amount else 0 end,
      case when v_tds > 0 then coalesce(p_tds_section, '194J') end, v_rate,
      null, p_invoice_id, case when v_tds > 0 then public.indian_fiscal_year(v_txn.txn_date) end);
  end if;

  v_pay_id := nullif(v_res->>'payment_id', '')::uuid;
  if v_pay_id is null then
    raise exception 'The payment was not recorded.' using errcode = 'P0001';
  end if;
  v_replay := coalesce((v_res->>'already_recorded')::boolean, false)
           or coalesce((v_res->>'idempotent_replay')::boolean, false);

  /* Invoice once fully paid, when the quote has none (record_payment never issues one).
     R-2095: a sale booked from a bank receipt is invoiced on its first receipt even if part-paid —
     the licence is live, so the tax invoice is for the whole supply with the balance due (Zoho does
     the same). A quote sent before payment keeps the fully-paid rule. */
  if v_quote_id is not null and not v_replay then
    select q.invoice_id into v_inv_now from public.quotes q where q.id = v_quote_id;
    if v_inv_now is null
       and (coalesce((v_res->>'is_fully_paid')::boolean, false)
            or coalesce((select q2.invoice_on_receipt from public.quotes q2 where q2.id = v_quote_id), false)
            /* R-2179: add-seats / renewal of a subscription billed yearly — invoice on the first receipt.
               A subscription billed in parts keeps its own part invoices (R-2044 / R-808). */
            or (v_kind in ('add_seats', 'renewal') and v_sub_id is not null
                and exists (select 1 from public.subscriptions s3
                             where s3.id = v_sub_id and s3.tenant_id = v_txn.tenant_id
                               and coalesce(s3.billing_cycle::text, 'yearly') = 'yearly')))
       and not exists (select 1 from public.subscriptions s
                        where s.tenant_id = v_txn.tenant_id and s.quote_id = v_quote_id
                          and s.billing_cycle is distinct from 'yearly'::public.billing_cycle)
       /* R-2044: a part payment request is never invoiced whole — its part's tax invoice is
          raised by tg_payments_part_quote_invoice when it is paid (raise_subscription_billing). */
       and not exists (select 1 from public.quotes pq
                        where pq.id = v_quote_id and pq.subscription_billing_id is not null) then
      select gi.invoice_id into v_inv_issued from public.generate_invoice(v_quote_id) gi;
      /* R-015's rule (record_desk_payment): a settled invoice is paid on the RECEIPT date. */
      update public.invoices set paid_date = v_txn.txn_date
       where id = v_inv_issued and tenant_id = v_txn.tenant_id and status = 'paid';
    end if;
  end if;

  return jsonb_build_object(
    'kind', v_kind, 'quote_id', v_quote_id, 'sub_id', v_sub_id, 'skip_sub', v_skip_sub,
    'invoice_issued', v_inv_issued, 'payment_id', v_pay_id, 'replay', v_replay, 'res', v_res);
end;
$$;
revoke all on function public.bank_credit_pay_item(uuid, integer, text, text, text, integer, numeric, text, boolean, date, date) from public, anon, authenticated;
grant execute on function public.bank_credit_pay_item(uuid, integer, text, text, text, integer, numeric, text, boolean, date, date) to service_role;

-- ── 2. What undoing an "A new sale" bank line takes back (R-2179) ─────────────────────────────
-- One reader for the confirm screen (bank_sale_undo_preview) and the undo itself
-- (unreconcile_bank_receipt), so the screen never says something the undo does not do.
-- A line booked through "A new sale" = the line names ONE receipt (matched_to_type 'payment') on a quote
-- marked invoice_on_receipt (bank_credit_new_sale_quote — R-2095). Not tenant-checked here: callers do.
create or replace function public._bank_sale_undo_scope(p_txn_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_txn    record;
  v_pay    record;
  v_q      record;
  v_subs   jsonb;
  v_tds    integer;
  v_bad    record;
  v_block  text := null;
  v_href   text := null;
begin
  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found or v_txn.matched_to_type is distinct from 'payment' or v_txn.matched_to_id is null then
    return jsonb_build_object('is_new_sale', false);
  end if;
  select p.* into v_pay from public.payments p
   where p.id::text = v_txn.matched_to_id and p.tenant_id = v_txn.tenant_id;
  if not found or v_pay.quote_id is null then
    return jsonb_build_object('is_new_sale', false);
  end if;
  select q.id, q.invoice_id, q.status, q.amount, q.customer_id, q.customer_name, q.invoice_on_receipt into v_q
    from public.quotes q where q.id = v_pay.quote_id and q.tenant_id = v_txn.tenant_id;
  if not found or not coalesce(v_q.invoice_on_receipt, false) then
    return jsonb_build_object('is_new_sale', false);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'plan', s.plan, 'domain', s.domain, 'seats', s.seats, 'status', s.status,
           'renewal_date', s.renewal_date, 'billing_cycle', s.billing_cycle) order by s.created_at, s.id), '[]'::jsonb)
    into v_subs
    from public.subscriptions s where s.tenant_id = v_txn.tenant_id and s.quote_id = v_q.id;
  select coalesce(sum(t.tds_amount), 0)::int into v_tds
    from public.tds_receivable t where t.tenant_id = v_txn.tenant_id and t.payment_id = v_pay.id;

  /* What stops the undo — each with the page to fix it on. */
  if exists (select 1 from public.payments p2
              where p2.tenant_id = v_txn.tenant_id and p2.quote_id = v_q.id and p2.id <> v_pay.id) then
    v_block := 'This sale has other receipts too, so it cannot be undone from this bank line. Open quote ' || v_q.id || ' and handle its payments there.';
    v_href  := '/quotes/' || v_q.id;
  end if;
  if v_block is null and v_q.invoice_id is not null and (
       exists (select 1 from public.credit_notes cn where cn.invoice_id = v_q.invoice_id)
    or exists (select 1 from public.debit_notes dn where dn.invoice_id = v_q.invoice_id)) then
    v_block := 'Invoice ' || v_q.invoice_id || ' already has a credit or debit note, so the sale cannot be undone from here. Open the invoice and settle it there.';
    v_href  := '/invoices/' || v_q.invoice_id;
  end if;
  if v_block is null then
    /* A TDS row of another receipt on this invoice, or one the customer already reported. */
    select t.id, t.status, t.tds_amount into v_bad
      from public.tds_receivable t
     where t.tenant_id = v_txn.tenant_id
       and ((v_q.invoice_id is not null and t.invoice_id = v_q.invoice_id) or t.payment_id = v_pay.id)
       and (t.payment_id is distinct from v_pay.id or t.status is distinct from 'pending_cert')
     order by t.id limit 1;
    if found then
      v_block := 'The ₹' || v_bad.tds_amount || ' TDS on this sale (' || v_bad.id || ') is marked "' || replace(coalesce(v_bad.status, ''), '_', ' ')
                 || '" — check it on TDS receivable (with your CA) before undoing the sale.';
      v_href  := '/accounting/tds-receivable';
    end if;
  end if;
  if v_block is null then
    /* A subscription of this sale already billed something else (a later part / term) on its own invoice. */
    select b.invoice_id, s.plan into v_bad
      from public.subscription_billings b
      join public.subscriptions s on s.id = b.subscription_id
     where s.tenant_id = v_txn.tenant_id and s.quote_id = v_q.id
       and b.invoice_id is not null and b.invoice_id is distinct from v_q.invoice_id
     order by b.bill_on, b.id limit 1;
    if found then
      v_block := 'The ' || coalesce(v_bad.plan, 'subscription') || ' made by this sale already billed invoice ' || v_bad.invoice_id
                 || ', so the sale cannot be undone from here. Settle that invoice first (credit note), then un-reconcile this line.';
      v_href  := '/invoices/' || v_bad.invoice_id;
    end if;
  end if;
  if v_block is null then
    /* A later quote on one of its subscriptions (renewal, add seats, a part request) that is not cancelled. */
    select q2.id into v_bad
      from public.quotes q2
      join public.subscriptions s on s.tenant_id = q2.tenant_id and s.quote_id = v_q.id
     where q2.tenant_id = v_txn.tenant_id and q2.id <> v_q.id
       and q2.status::text not in ('rejected', 'expired')
       and (q2.renewal_subscription_id = s.id or q2.add_seats_subscription_id = s.id or s.renewal_quote_id = q2.id
            or q2.subscription_billing_id in (select b.id from public.subscription_billings b where b.subscription_id = s.id))
     order by q2.id limit 1;
    if found then
      v_block := 'Quote ' || v_bad.id || ' was made later on a subscription of this sale. Cancel (reject) that quote first, then un-reconcile this line.';
      v_href  := '/quotes/' || v_bad.id;
    end if;
  end if;

  return jsonb_build_object(
    'is_new_sale', true,
    'payment_id', v_pay.id, 'receipt_voucher_no', v_pay.receipt_voucher_no, 'amount', v_pay.amount,
    'quote_id', v_q.id, 'invoice_id', v_q.invoice_id,
    'customer_id', v_q.customer_id, 'customer_name', v_q.customer_name,
    'subscriptions', v_subs, 'tds_amount', v_tds,
    'blocked', v_block is not null, 'block_message', v_block, 'block_href', v_href);
end;
$$;
revoke all on function public._bank_sale_undo_scope(uuid) from public, anon, authenticated;
grant execute on function public._bank_sale_undo_scope(uuid) to service_role;

-- The confirm screen's reader: what "Undo this sale too" takes back, and whether it can.
create or replace function public.bank_sale_undo_preview(p_txn_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2179: read-only; the same roles as unreconcile_bank_receipt; never another company's line. */
declare
  v_trusted boolean;
  v_tenant  uuid := public.current_tenant_id();
  v_txn_tenant uuid;
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and v_tenant is null then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can un-match a bank line' using errcode = '42501';
  end if;
  select t.tenant_id into v_txn_tenant from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank transaction not found' using errcode = 'no_data_found'; end if;
  if not v_trusted and v_txn_tenant is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  return public._bank_sale_undo_scope(p_txn_id);
end;
$$;
revoke all on function public.bank_sale_undo_preview(uuid) from public, anon;
grant execute on function public.bank_sale_undo_preview(uuid) to authenticated, service_role;

-- ── 3. unreconcile_bank_receipt (from 20261101131404_r1997_project_receipt_advance — its latest body) ──
CREATE OR REPLACE FUNCTION public.unreconcile_bank_receipt(p_txn_id uuid, p_undo_sale boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_pay     public.payments;
  v_quote   record;
  v_inv     record;
  v_invoice text;
  v_cn      jsonb;
  v_voided  text;
  v_adv     public.payments;
  v_adv_open integer;
  v_adv_bad  integer;
  -- R-1999: the project branch
  v_pp_ids   uuid[];
  v_tds_rows text[];
  v_ms_ids   uuid[];
  v_inv_ids  text[];
  v_pp_bank  integer;
  v_pp_tds   integer;
  v_pp_n     integer;
  v_bad      record;
  -- R-1997: the line's advance receipts
  v_adv_ids   uuid[];
  v_adv_total integer;
  -- R-2179: a line booked through "A new sale"
  v_scope     jsonb := null;
  v_new_sale  boolean := false;
  v_tds_gone  integer := 0;
  v_subs_n    integer := 0;
begin
/* R-2179: "Undo this sale too" also works for a line booked through "A new sale" (bank_credit_new_sale_quote,
   quotes.invoice_on_receipt) — receipt removed (voucher kept as cancelled), its TDS row (still
   pending_cert) removed, invoice credit-noted, quote rejected, and every subscription the sale made
   cancelled with its unbilled parts removed. Refused (nothing changes) when the sale has another receipt,
   a credit/debit note, a reported TDS, a subscription that billed something else, or a later live quote
   on one of its subscriptions — _bank_sale_undo_scope, the same reader as bank_sale_undo_preview. */
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can un-match a bank line' using errcode = '42501';
  end if;
  /* R-718: "undo the sale" deletes the receipt — a delete, so owner / accountant only. */
  if p_undo_sale and not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete a payment' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found then raise exception 'Bank transaction not found' using errcode = 'no_data_found'; end if;
  if v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;


  /* R-1999 (R-1910 c8, D3): a line booked as a PROJECT receipt — un-reconciling takes back the
     whole booking (every kist's bank part, its TDS payment and TDS receivable row), works each
     kist's status out again and frees the line, in this one transaction. Every invoice STAYS
     (D3: no credit note, the GST series is never broken) and shows as due again. */
  if v_txn.matched_to_type = 'project' then
    select array_agg(r.payment_id) filter (where r.payment_id is not null),
           array_agg(r.tds_receivable_id) filter (where r.tds_receivable_id is not null)
      into v_pp_ids, v_tds_rows
      from public.project_receipt_line_rows(p_txn_id) r;

    /* R-1997: the money this line kept as the customer's ADVANCE (allocate_project_receipt_with_tds
       — R-1863's receipt + credit, payments.bank_txn_id = the line) goes back with the kists.
       R-1863's rule: refused while any of that credit is used or refunded; owner / accountant
       (removing a receipt). Read now — un-matching the line clears bank_txn_id (R-2098 trigger). */
    select array_agg(p.id order by p.id), coalesce(sum(p.amount), 0)::int
      into v_adv_ids, v_adv_total
      from public.payments p
     where p.tenant_id = v_tenant and p.bank_txn_id = p_txn_id
       and public.bank_advance_payment(p.id);
    if coalesce(cardinality(v_adv_ids), 0) > 0 then
      perform 1 from public.payments where id = any(v_adv_ids) order by id for update;
      if not (coalesce(public.current_request_role(), '') = 'service_role'
              or (public.current_request_role() is null
                  and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
         and not public.current_user_has_role('owner', 'accountant') then
        raise exception 'Un-reconciling this line removes the ₹% advance it kept for the customer. Only an owner or accountant can remove a receipt — ask them to un-reconcile this line.',
          v_adv_total using errcode = '42501';
      end if;
      perform 1 from public.customer_credits cc
        where cc.tenant_id = v_tenant and cc.source_payment_id = any(v_adv_ids) order by cc.id for update;
      select coalesce(sum(cc.amount) filter (where cc.status = 'open'), 0)::int,
             coalesce(sum(cc.amount) filter (where cc.status <> 'open'), 0)::int
        into v_adv_open, v_adv_bad
        from public.customer_credits cc
       where cc.tenant_id = v_tenant and cc.source_payment_id = any(v_adv_ids);
      if v_adv_bad > 0 or v_adv_open <> v_adv_total then
        raise exception 'This line''s ₹% advance has ₹% already used or refunded, so it cannot be taken back. Undo that first: on the customer''s Payments, delete or refund the payment that used the credit (the credit opens again), then un-reconcile this line.',
          v_adv_total, v_adv_total - v_adv_open using errcode = 'check_violation', hint = '/payments';
      end if;
    end if;

    if coalesce(cardinality(v_pp_ids), 0) > 0 or coalesce(cardinality(v_tds_rows), 0) > 0 then
      perform 1 from public.project_payments where id = any(v_pp_ids) order by id for update;
      select coalesce(sum(amount) filter (where coalesce(method, '') <> 'tds'), 0)::int,
             coalesce(sum(amount) filter (where method = 'tds'), 0)::int,
             count(*)::int
        into v_pp_bank, v_pp_tds, v_pp_n
        from public.project_payments where id = any(v_pp_ids);

      if not (coalesce(public.current_request_role(), '') = 'service_role'
              or (public.current_request_role() is null
                  and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
         and not public.current_user_has_role('owner', 'accountant') then
        raise exception 'Un-reconciling this line removes the ₹% project payment it booked%. Only an owner or accountant can remove a payment — ask them to un-reconcile this line.',
          v_pp_bank, case when v_pp_tds > 0 then format(' (and ₹%s TDS)', v_pp_tds) else '' end
          using errcode = '42501';
      end if;

      /* A TDS the customer has already reported (certificate in / seen in 26AS) is not taken off here. */
      select t.id, t.tds_amount, t.status into v_bad
        from public.tds_receivable t
       where t.id = any(v_tds_rows) and t.status is distinct from 'pending_cert'
       order by t.id limit 1;
      if found then
        raise exception 'The ₹% TDS on this receipt (%) is already marked "%" on TDS receivable — the customer has reported it. Check it there (with your CA) before un-reconciling this line.',
          v_bad.tds_amount, v_bad.id, replace(v_bad.status, '_', ' ')
          using errcode = 'check_violation', hint = '/accounting/tds-receivable';
      end if;

      /* A referral commission already PAID out on one of these payments would be left with nothing behind it. */
      select rc.gross_commission as amount into v_bad
        from public.referral_commissions rc
       where rc.project_payment_id = any(v_pp_ids) and rc.status = 'paid'
       limit 1;
      if found then
        raise exception 'A referral commission of ₹% is already paid on this project payment. Undo that commission payment first (Referrals), then un-reconcile this line.',
          v_bad.amount using errcode = 'check_violation', hint = '/referrals';
      end if;

      select array_agg(distinct pp.milestone_id) filter (where pp.milestone_id is not null)
        into v_ms_ids
        from public.project_payments pp where pp.id = any(v_pp_ids);
      perform 1 from public.project_milestones where id = any(v_ms_ids) order by id for update;
      select array_agg(distinct m.invoice_id) filter (where m.invoice_id is not null)
        into v_inv_ids
        from public.project_milestones m where m.id = any(v_ms_ids);

      delete from public.tds_receivable where id = any(v_tds_rows) and tenant_id = v_tenant;
      -- the invoice's paid_amount / status follow through trg_project_payment_sync_invoice
      delete from public.project_payments where id = any(v_pp_ids) and tenant_id = v_tenant;

      update public.project_milestones m
         set status = case
               when (select coalesce(sum(pp.amount), 0) from public.project_payments pp where pp.milestone_id = m.id) >= m.total_amount then 'paid'
               when m.invoice_id is not null then 'invoiced'
               else 'pending' end
       where m.id = any(v_ms_ids);

      -- D3: the invoice stays; once it is not paid in full it has no paid date
      update public.invoices
         set paid_date = null, updated_at = now()
       where id = any(v_inv_ids) and tenant_id = v_tenant and status is distinct from 'paid'::invoice_status;

      select array_agg(i.id order by i.id) into v_inv_ids
        from public.invoices i where i.id = any(v_inv_ids) and i.status is distinct from 'paid'::invoice_status;

      update public.project_sales set updated_at = now()
       where id in (select distinct m.project_id from public.project_milestones m where m.id = any(v_ms_ids));
    end if;

    perform public.reconcile_bank_txn(p_txn_id, null, null, 'manual');

    /* R-1997: the advance receipt(s) go as R-1863's do — delete_payment (voucher kept as
       cancelled, open credit removed), holder quote rejected. */
    if coalesce(cardinality(v_adv_ids), 0) > 0 then
      for i in 1 .. cardinality(v_adv_ids) loop
        select * into v_adv from public.payments where id = v_adv_ids[i];
        perform public.delete_payment(v_adv.id);
        update public.quotes
           set status = 'rejected'::quote_status, payment_status = 'none'::payment_status, payment_amount = 0,
               payment_method = null, payment_reference = null, payment_received_at = null, payment_notes = null
         where id = v_adv.quote_id and tenant_id = v_tenant;
      end loop;
    end if;

    return jsonb_build_object(
      'unreconciled', true, 'invoice_voided', null, 'invoice_credited', null, 'credit_note_id', null,
      'receipt_removed', null,
      'advance_removed', coalesce(v_adv_total, 0),
      'project_payments_removed', coalesce(v_pp_n, 0),
      'project_amount_removed', coalesce(v_pp_bank, 0),
      'project_tds_removed', coalesce(v_pp_tds, 0),
      'invoices_due_again', coalesce(to_jsonb(v_inv_ids), '[]'::jsonb));
  end if;

  /* R-1863: a line booked as a customer's ADVANCE — un-reconciling takes the advance back:
     its receipt and its credit go, so the money is not counted with no bank line behind it. */
  if v_txn.matched_to_type = 'payment' and v_txn.matched_to_id is not null
     and public.bank_advance_payment(v_txn.matched_to_id::uuid) then
    select * into v_adv from public.payments where id = v_txn.matched_to_id::uuid for update;
    if not (coalesce(public.current_request_role(), '') = 'service_role'
            or (public.current_request_role() is null
                and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
       and not public.current_user_has_role('owner', 'accountant') then
      raise exception 'Un-reconciling this line removes the ₹% advance it booked (receipt %). Only an owner or accountant can remove a receipt — ask them to un-reconcile this line.',
        v_adv.amount, coalesce(v_adv.receipt_voucher_no, v_adv.id::text) using errcode = '42501';
    end if;
    perform 1 from public.customer_credits cc
      where cc.tenant_id = v_tenant and cc.source_payment_id = v_adv.id for update;
    select coalesce(sum(cc.amount) filter (where cc.status = 'open'), 0)::int,
           coalesce(sum(cc.amount) filter (where cc.status <> 'open'), 0)::int
      into v_adv_open, v_adv_bad
      from public.customer_credits cc
     where cc.tenant_id = v_tenant and cc.source_payment_id = v_adv.id;
    if v_adv_bad > 0 or v_adv_open <> v_adv.amount then
      raise exception 'This line''s ₹% advance has ₹% already used or refunded, so it cannot be taken back. Undo that first: on the customer''s Payments, delete or refund the payment that used the credit (the credit opens again), then un-reconcile this line.',
        v_adv.amount, v_adv.amount - v_adv_open using errcode = 'check_violation';
    end if;

    perform public.reconcile_bank_txn(p_txn_id, null, null, 'manual');
    perform public.delete_payment(v_adv.id);
    update public.quotes
       set status = 'rejected'::quote_status, payment_status = 'none'::payment_status, payment_amount = 0,
           payment_method = null, payment_reference = null, payment_received_at = null, payment_notes = null
     where id = v_adv.quote_id and tenant_id = v_tenant;

    return jsonb_build_object(
      'unreconciled', true, 'invoice_voided', null, 'invoice_credited', null, 'credit_note_id', null,
      'receipt_removed', v_adv.id, 'advance_removed', v_adv.amount);
  end if;

  if p_undo_sale then
    if v_txn.matched_to_type is distinct from 'payment' or v_txn.matched_to_id is null then
      raise exception 'This line is not reconciled to a customer receipt — nothing to undo.';
    end if;
    select * into v_pay from public.payments where id = v_txn.matched_to_id::uuid for update;
    if not found then raise exception 'The receipt this line points to no longer exists.'; end if;
    /* R-2179: a sale booked through "A new sale" (invoice_on_receipt) can be undone too. */
    if v_pay.notes is distinct from 'Reconciled from bank receipt' then
      v_scope := public._bank_sale_undo_scope(p_txn_id);
      v_new_sale := coalesce((v_scope->>'is_new_sale')::boolean, false);
      if not v_new_sale then
        raise exception 'This receipt was recorded separately, not from this bank line — undo it from Payments instead.';
      end if;
    end if;

    select id, invoice_id into v_quote from public.quotes where id = v_pay.quote_id for update;
    v_invoice := v_quote.invoice_id;
    if v_new_sale then
      perform 1 from public.subscriptions s where s.tenant_id = v_tenant and s.quote_id = v_pay.quote_id order by s.id for update;
      v_scope := public._bank_sale_undo_scope(p_txn_id);   -- again, under the locks
      if coalesce((v_scope->>'blocked')::boolean, false) then
        raise exception '%', v_scope->>'block_message' using errcode = 'check_violation', hint = coalesce(v_scope->>'block_href', '');
      end if;
    end if;
    if exists (select 1 from public.payments where quote_id = v_pay.quote_id and id <> v_pay.id) then
      raise exception 'This sale has other receipts too — undo it from the invoice, not from here.';
    end if;
    if not v_new_sale and v_invoice is not null and (
         exists (select 1 from public.credit_notes where invoice_id = v_invoice)
      or exists (select 1 from public.debit_notes where invoice_id = v_invoice)
      or exists (select 1 from public.tds_receivable where invoice_id = v_invoice)
    ) then
      raise exception 'Invoice % has a credit/debit note or TDS entry — handle it from the invoice.', v_invoice;
    end if;
  end if;

  -- Free the line through the one reconcile path, so every other reversal still runs.
  perform public.reconcile_bank_txn(p_txn_id, null, null, 'manual');

  if p_undo_sale then
    /* R-2179: the sale's TDS (still pending_cert — the scope refused anything else) goes with its receipt. */
    if v_new_sale then
      with gone as (
        delete from public.tds_receivable t
         where t.tenant_id = v_tenant and t.payment_id = v_pay.id and t.status = 'pending_cert'
        returning t.tds_amount)
      select coalesce(sum(tds_amount), 0)::int into v_tds_gone from gone;
    end if;
    if v_invoice is not null then
      select id, status, amount into v_inv from public.invoices where id = v_invoice and tenant_id = v_tenant for update;
      if found then
        if v_inv.status = 'draft' then
          update public.invoices set status = 'void'::invoice_status, paid_date = null
           where id = v_invoice and tenant_id = v_tenant;
          v_voided := v_invoice;
        elsif v_inv.status = 'void' then
          -- R-1566: already cancelled in full — no credit note on a void invoice.
          null;
        else
          -- Issued: reverse with a full credit note; the invoice stays, nothing due.
          -- R-1566: p_settle = false — this sale's money is being taken back (the receipt is
          -- deleted below), so the note must not turn it into customer credit.
          v_cn := public.issue_credit_note_core(v_invoice, v_inv.amount, 'cancellation',
                    'Sale reversed — bank receipt un-reconciled',
                    'unreconcile_bank_receipt ' || p_txn_id::text, false);
          update public.invoices
             set status = 'pending'::invoice_status, paid_date = null, paid_amount = 0, net_payable = 0, updated_at = now()
           where id = v_invoice and tenant_id = v_tenant;
        end if;
      end if;
    end if;
    /* R-1863: the receipt voucher number stays in the record, marked cancelled (CGST 31(3)(d)
       series — never deleted or re-issued), as delete_payment does since R-1568. */
    if v_pay.receipt_voucher_no is not null then
      insert into public.cancelled_vouchers
        (tenant_id, doc_type, doc_no, payment_id, quote_id, customer_id, amount, credit_applied,
         received_at, reason, cancelled_by)
      values
        (v_pay.tenant_id, 'receipt_voucher', v_pay.receipt_voucher_no, v_pay.id, v_pay.quote_id,
         v_pay.customer_id, v_pay.amount, coalesce(v_pay.credit_applied, 0),
         v_pay.received_at, 'Bank sale undone — bank line un-reconciled', public.current_user_id());
    end if;
    delete from public.payments where id = v_pay.id;
    update public.quotes
       set status = 'rejected'::quote_status,
           payment_status = 'none'::payment_status,
           payment_amount = 0,
           payment_method = null, payment_reference = null,
           payment_received_at = null, payment_notes = null
     where id = v_pay.quote_id and tenant_id = v_tenant;

    /* R-2179: every subscription this sale made ends — its unbilled parts go, nothing is due on it
       (the sale's invoice is credit-noted above), and it leaves MRR and renewals. */
    if v_new_sale then
      delete from public.subscription_billings b
       using public.subscriptions s
       where b.subscription_id = s.id and s.tenant_id = v_tenant and s.quote_id = v_pay.quote_id
         and b.invoice_id is null;
      update public.subscriptions s
         set status = 'cancelled'::public.sub_status,
             cancelled_at = now(),
             cancel_reason = 'Sale undone — bank line of ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ' un-reconciled',
             outstanding_amount = 0,
             updated_at = now()
       where s.tenant_id = v_tenant and s.quote_id = v_pay.quote_id and s.status is distinct from 'cancelled'::public.sub_status;
      get diagnostics v_subs_n = row_count;
    end if;
  end if;

  return jsonb_build_object(
    'unreconciled', true,
    'invoice_voided', v_voided,
    'invoice_credited', case when v_cn is not null then v_invoice end,
    'credit_note_id', v_cn->>'credit_note_id',
    'receipt_removed', case when p_undo_sale then v_pay.id end,
    'tds_removed', v_tds_gone,                 -- R-2179
    'subscriptions_cancelled', v_subs_n        -- R-2179
  );
end;
$function$;

revoke all on function public.unreconcile_bank_receipt(uuid, boolean) from public, anon;
grant execute on function public.unreconcile_bank_receipt(uuid, boolean) to authenticated, service_role;

commit;
