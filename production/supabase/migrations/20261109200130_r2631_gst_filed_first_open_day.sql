-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.invoice_date_for_receipt(uuid,date)') and prosrc like '%R-2631%') and to_regprocedure('public.invoice_receipt_day(uuid,date)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_credit_pay_item(uuid,integer,text,text,text,integer,numeric,text,boolean,date,date)') and prosrc like '%R-2631%')
-- deploy-key: r2631gstfiledfirstopenday
-- 20261109200130_r2631_gst_filed_first_open_day.sql
--
-- R-2631 (9 Nov 2026, p1 money, G-FY2526 D7 — fix card from R-2627's review). Owner's decision (Pardeep,
-- 9 Nov, option A): on every NON-bank path — Generate invoice, desk Record payment, the Razorpay webhook,
-- the billing / renewal cron and a part request's part invoice (dated on the part's bill date, also when
-- it is paid late from an open month) — the money is ALWAYS recorded, and a NEW tax invoice is NEVER dated
-- in a GST-filed month: it is dated on the first open day instead (as the books lock already did).
--
--   1. invoice_receipt_day(tenant, day) — R-2095's clamp, unchanged: the receipt / bill day, not after
--      today, never on or before books_locked_until.
--   2. invoice_date_for_receipt(tenant, day) — the ONE date both invoice makers use (generate_invoice,
--      latest body 20261109181239_r2636; raise_subscription_billing, latest body 20261030153513_r2095) and
--      the Issue-invoice confirm reads (R-2635's useInvoiceIssueDate): invoice_receipt_day, then moved to
--      the first day that is NOT GST-filed by R-2621's one rule gst_filed_why (GST filed up to / books lock /
--      GSTR-1 of the month or its FY quarter marked filed). So the invoice NUMBER (next_document_number on
--      that date → that date's FY series), its due date (date + terms) and its GSTR-1 month all follow the
--      new date; the receipt keeps its own date. A login asking about another company is refused (42501).
--      Bounded walk: 120 months; past that a plain error (never a hang).
--   3. bank_credit_pay_item ← 20261109112645_r2627 (its latest body). Bank paths stay REFUSED (R-2627):
--      its guard now reads the day the invoice would carry BEFORE the GST shift (invoice_receipt_day of the
--      quote's latest receipt — what generate_invoice used before R-2631), because the invoice it raised is
--      now dated in an open month and the old check (that invoice's own date) would never fire. Same
--      message, same rollback. No other change in its body.
--   Not changed: invoices already raised (no data repair); R-2621's refusal of a new sale from a bank line
--   (bank_credit_new_sale_quote, on the bank day); create_direct_invoice / project milestone invoices (dated
--   when issued — today). Test: supabase/tests/r2631_gst_filed_first_open_day.test.sql

begin;

-- ── 1. R-2095's clamp, kept under its own name ─────────────────────────────────────────────────
create or replace function public.invoice_receipt_day(p_tenant_id uuid, p_date date)
returns date
language sql
stable
security definer
set search_path = public
as $$
  /* R-2631: R-2095's clamp (was invoice_date_for_receipt) — the receipt / bill date, not after today,
     never inside locked books. Before the GST-filed shift; bank_credit_pay_item's refusal reads it. */
  select greatest(least(coalesce(p_date, public.ist_today()), public.ist_today()),
                  coalesce((select t.books_locked_until + 1 from public.tenants t where t.id = p_tenant_id), '-infinity'::date));
$$;
revoke all on function public.invoice_receipt_day(uuid, date) from public, anon, authenticated;
grant execute on function public.invoice_receipt_day(uuid, date) to service_role;

-- ── 2. The one invoice date: first open (not GST-filed) day ────────────────────────────────────
create or replace function public.invoice_date_for_receipt(p_tenant_id uuid, p_date date)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2095: the receipt / bill date, not after today, and never inside locked books.
   R-2631 (owner, option A): never in a GST-filed month either — the first open day by R-2621's one rule
   (gst_filed_why: GST filed up to / books lock / GSTR-1 of the month or FY quarter marked filed). */
declare
  v_caller uuid := public.current_tenant_id();
  v_t      record;
  v_day    date;
  i        integer := 0;
begin
  if p_tenant_id is null then return null; end if;
  if v_caller is not null and v_caller is distinct from p_tenant_id then
    raise exception 'Not your company' using errcode = '42501';
  end if;
  v_day := public.invoice_receipt_day(p_tenant_id, p_date);
  select t.gst_filed_through, t.books_locked_until into v_t from public.tenants t where t.id = p_tenant_id;
  while public.gst_filed_why(p_tenant_id, v_day) is not null loop
    i := i + 1;
    if i > 120 then
      raise exception 'Every month from % on is marked GST-filed, so this invoice has no open day to be dated on. Check Accounting → Overview → GST returns filed up to, and the GSTR-1 marks in the Compliance Calendar.',
        to_char(public.invoice_receipt_day(p_tenant_id, p_date), 'FMMon YYYY') using errcode = 'check_violation';
    end if;
    v_day := case
               when v_t.gst_filed_through is not null and v_day <= v_t.gst_filed_through then v_t.gst_filed_through + 1
               when v_t.books_locked_until is not null and v_day <= v_t.books_locked_until then v_t.books_locked_until + 1
               else (date_trunc('month', v_day) + interval '1 month')::date   -- GSTR-1 of this month / quarter marked filed
             end;
  end loop;
  return v_day;
end;
$$;
comment on function public.invoice_date_for_receipt(uuid, date) is
  'R-2095 + R-2631: the date a new tax invoice for this receipt / bill day carries - not after today, never in locked books, never in a GST-filed month (gst_filed_why): the first open day instead.';
revoke all on function public.invoice_date_for_receipt(uuid, date) from public, anon;
grant execute on function public.invoice_date_for_receipt(uuid, date) to authenticated, service_role;

-- ── 3. bank_credit_pay_item (from 20261109112645_r2627 — its latest body) ─────────────────────
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
   the seats / the new term are live, so the tax invoice is for the whole supply with the balance due.
   R-2627: no NEW tax invoice dated in a GST-filed month (R-2621's one rule, gst_filed_why) — a quote with no
   invoice yet, paid from a bank line, is refused when the invoice this payment raises (generate_invoice on
   the receipt day) would fall on a GST-filed day. The whole call is
   undone (nothing saved). Paying an invoice that already exists is unchanged.
   R-2631: generate_invoice now dates a new invoice on the first OPEN day (invoice_date_for_receipt), so the
   guard reads the day it would carry before that shift (invoice_receipt_day of the latest receipt) - a bank
   path stays refused (owner, option A: only non-bank paths move to the first open day). */
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
  v_inv_date   date;             -- R-2627: the date of the invoice this payment raised (R-2631: before the GST shift)
  v_why        text;             -- R-2627: why its day's GST is filed
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
                /* the quote's own cycle too: a renewal that moves a yearly sub to parts is billed per part */
                and coalesce(v_quote.billing_cycle::text, 'yearly') = 'yearly'
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

  /* R-2627: the tax invoice this payment raised must not be dated in a GST-filed month (it would change a
     filed GSTR-1). Raised here, the whole call is undone — the receipt, the invoice; the line stays unmatched. */
  if v_inv_issued is not null then
    /* R-2631: the day before the GST-filed shift - the latest received receipt's IST day, clamped as R-2095. */
    v_inv_date := public.invoice_receipt_day(v_txn.tenant_id,
      (select max((p.received_at at time zone 'Asia/Kolkata')::date) from public.payments p
        where p.quote_id = v_quote_id and p.status = 'received'));
    v_why := public.gst_filed_why(v_txn.tenant_id, v_inv_date);
    if v_why is not null then
      raise exception 'GST for % is already filed (%), so quote % cannot get a new tax invoice dated % — that would change a filed return. Nothing was saved. If this sale''s invoice is in Zoho, import it (Invoices → FY sales from Zoho) and pay that invoice; if the money came before the sale, book it as "Advance — nothing to invoice yet" and invoice the quote in an open month.',
        to_char(v_inv_date, 'FMMon YYYY'), v_why, v_quote_id, to_char(v_inv_date, 'FMDD Mon YYYY')
        using errcode = 'check_violation';
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
