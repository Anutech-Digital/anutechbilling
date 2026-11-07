-- deploy-peek: to_regprocedure('public.bank_credit_tds_part_gross(integer,integer,integer)') is not null and to_regprocedure('public.bank_credit_tds_gross(integer,integer,integer,integer,numeric)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_credit_pay_item(uuid,integer,text,text,text,integer,numeric,text,boolean,date,date)') and prosrc like '%R-2538%')
-- deploy-key: r2538tdsgrosspartpaid
--
-- R-2538 (7 Nov 2026, p1 money) — staging Excel: TDS-CD79F6A752 on receipt RV-A378-27-0184 (part 1 of the
-- half-yearly sale Q-A378-27-0191) stored gross ₹1,57,500 = the WHOLE year's quote subtotal; the part paid
-- was ₹78,750 (TDS ₹1,575 itself was right). Repaired by hand on 6 Nov. Plus R-2542's review lows.
--
-- ─── WHAT THIS CHANGES ──────────────────────────────────────────────────────────────────────────
--   bank_credit_pay_item(...)  ← 20261106155253_r2542 (its latest body). Same signature and grants.
--   1. TDS gross = the taxable value of the PART this receipt pays, on every path (quote, quote-linked
--      invoice, instalment, Zoho / opening invoice): gross = (money + TDS) × taxable ÷ GST-inclusive total,
--      never more than the taxable value. A receipt for the whole document still gives the whole taxable.
--      Was: the whole quote subtotal / the whole invoice taxable — so a sale billed in parts, or a Zoho
--      sale paid in parts, got one full-gross TDS row per part (R-2542 review #1).
--      Exception: the operator gives a rate and the TDS does not fit it on the part (the customer deducted
--      on the whole document from part 1) → gross = TDS × 100 ÷ rate, capped at the taxable — what 26AS shows.
--      Taxable and total always come from ONE document (an invoice with no taxable → the quote's both).
--      No taxable at all → gross 0, as before (tds_receivable.gross_amount is NOT NULL).
--   2. The TDS rate, when the caller gives none, is derived from THAT gross (tds × 100 ÷ gross, 2 dp) on
--      every path. Was: null on the quote path; on the Zoho path derived from the whole taxable (too low).
--   3. Zoho / opening replay (the same reference already a receipt on the invoice) is a replay only when
--      the money matches too (receipt = line + TDS, or receipt − its booked TDS = line); the same reference
--      with another amount is refused — never silently matched to the old receipt, never a second receipt
--      (R-2542 review #2).
--   4. A written-off invoice takes no NEW receipt on every invoice path (R-2542 review #3); a freed line
--      whose receipt was kept still goes back to it. bank_credit_open_items already left it out.
--   Not changed: the callers (reconcile_bank_credit_to_item / _split / _new_sale / _fx_invoice),
--   _record_opening_invoice_payment, record_desk_payment, record_instalment_payment, bank_credit_open_items.
-- Test: supabase/tests/r2538_tds_gross_part_paid.test.sql (begin … rollback; red without this file).
-- Scan (read-only, staging): tds_receivable rows whose gross_amount ≠ the paid part's taxable — listed on
-- the card for Pardeep; NOT repaired here.

begin;

-- ── 1. The part's taxable value (R-2538) ─────────────────────────────────────────────────────────
-- (money + TDS) × taxable ÷ GST-inclusive total, whole rupees, never above the taxable value; a receipt
-- for the whole document (or no usable total) gives the whole taxable. Null taxable → null (no TDS base).
create or replace function public.bank_credit_tds_part_gross(p_paid integer, p_taxable integer, p_total integer)
returns integer
language sql
immutable
as $$
  select case
           when p_taxable is null or p_taxable <= 0 then null
           when coalesce(p_total, 0) <= 0 or coalesce(p_paid, 0) >= p_total then p_taxable
           when coalesce(p_paid, 0) <= 0 then 0
           else least(p_taxable, round(p_paid * p_taxable::numeric / p_total)::integer)
         end
$$;
revoke all on function public.bank_credit_tds_part_gross(integer, integer, integer) from public, anon;
grant execute on function public.bank_credit_tds_part_gross(integer, integer, integer) to authenticated, service_role;
comment on function public.bank_credit_tds_part_gross(integer, integer, integer) is
  'R-2538: TDS gross for a receipt that pays a PART of a document = (money + TDS) × taxable ÷ GST-inclusive total, capped at the taxable value.';

-- ── 1b. The gross the customer deducted on (R-2538 review) ───────────────────────────────────────
-- The part's taxable (above) — unless the operator gave a rate and the TDS does not fit it on that part
-- (the customer deducted on more than this part, e.g. 2% of the whole year's taxable from part 1): then
-- the gross is TDS × 100 ÷ rate, as the customer's 26AS shows it, never above the document's taxable.
-- ±₹1 is TDS rounding. Never null: 0 when the document has no taxable value (R-2542's 0).
create or replace function public.bank_credit_tds_gross(p_paid integer, p_taxable integer, p_total integer, p_tds integer, p_rate numeric)
returns integer
language sql
immutable
as $$
  select case
           when coalesce(p_tds, 0) > 0 and coalesce(p_rate, 0) > 0 and g.part is not null
                and abs(round(g.part * p_rate / 100) - p_tds) > 1
             then least(p_taxable, round(p_tds * 100 / p_rate)::integer)
           else coalesce(g.part, 0)
         end
    from (select public.bank_credit_tds_part_gross(p_paid, p_taxable, p_total) as part) g
$$;
revoke all on function public.bank_credit_tds_gross(integer, integer, integer, integer, numeric) from public, anon;
grant execute on function public.bank_credit_tds_gross(integer, integer, integer, integer, numeric) to authenticated, service_role;
comment on function public.bank_credit_tds_gross(integer, integer, integer, integer, numeric) is
  'R-2538: TDS gross for a receipt = the paid part''s taxable; when a given rate does not fit the TDS on that part, TDS × 100 ÷ rate (capped at the taxable). 0 when there is no taxable.';

-- ── 2. bank_credit_pay_item (from 20261106155253_r2542 — its latest body) ──────────────────────
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
   the amount too; a written-off invoice is refused. */
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
            or coalesce((select q2.invoice_on_receipt from public.quotes q2 where q2.id = v_quote_id), false))
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

commit;
