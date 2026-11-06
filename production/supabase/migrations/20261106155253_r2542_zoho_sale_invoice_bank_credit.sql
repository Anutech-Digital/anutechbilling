-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_credit_open_items(uuid)') and prosrc like '%R-2542%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.bank_credit_pay_item(uuid,integer,text,text,text,integer,numeric,text,boolean,date,date)') and prosrc like '%R-2542%')
-- deploy-key: r2542zohosaleinvoicebankcredit
--
-- R-2542 (6 Nov 2026, p1 money) — staging Excel: INV/25-26/1913 (an FY 2025-26 sale imported from Zoho,
-- R-2499 — invoices.zoho_invoice_id, no quote, no instalment) could not take its ₹87,696 bank receipt:
-- Banking → Reconcile → "An open quote / invoice" listed only quotes, and "This money is for" refused
-- the invoice ("no quote or subscription behind it"). 2,353 imported FY sales are in the same state.
--
-- ─── WAS IT ON PURPOSE? ─────────────────────────────────────────────────────────────────────────
--   No. R-2501 already made such an invoice take a quote-less receipt everywhere else:
--   trg_payments_opening_invoice, _opening_invoice_settle, _record_opening_invoice_payment and
--   record_multi_invoice_payment all accept `document_kind = 'opening_invoice' OR zoho_invoice_id is
--   not null`. R-2466's two bank functions were written a day earlier and still test only
--   document_kind = 'opening_invoice'. This file gives them R-2501's rule (+ the two fixes below).
--
-- ─── WHAT THIS CHANGES ──────────────────────────────────────────────────────────────────────────
--   bank_credit_open_items(customer)  ← 20261104045700_r2466 (latest): an open invoice with no quote
--       that is a Zoho opening invoice OR an FY sale imported from Zoho is kind 'opening' (was: opening
--       invoices only). Same columns, so create or replace (grants re-stated).
--   bank_credit_pay_item(...)          ← 20261104045700_r2466 (latest): the same rule picks the
--       quote-less receipt branch (_record_opening_invoice_payment — receipt voucher, the line's bank
--       account and date, TDS receivable; replay on the same reference; more than its due refused).
--       Two small fixes in that branch: the TDS gross is the invoice's taxable value (the quote path's
--       rule — was the GST-inclusive receipt), and the replay is looked up BEFORE the "is paid" refusal,
--       so a line un-reconciled (receipt kept) from an invoice it paid in full matches back to it.
--   Unchanged on purpose: a hand-made tax invoice with no quote, no instalment and no Zoho id still has
--   no payment path (the receipt trigger refuses it), so it stays out of the list. Not changed:
--   reconcile_bank_credit_to_item / _split / _fx_invoice (they call these two), bank_line_kept_receipt_ref
--   (already finds a quote-less receipt by its invoice), _record_opening_invoice_payment (R-2501).
--   Books lock: trg_books_lock on payments. Tenant gate + line lock: the callers (unchanged).
-- Test: supabase/tests/r2542_zoho_sale_invoice_pay.test.sql (begin … rollback; red without this file).

begin;

-- ── 1. bank_credit_open_items (from 20261104045700_r2466 — same columns) ────────────────────────
create or replace function public.bank_credit_open_items(p_customer_id uuid)
returns table (
  kind               text,      -- renewal | add_seats | new | one_off | invoice | instalment | opening (R-2466)
  quote_id           text,
  invoice_id         text,
  doc_date           date,
  amount_due         integer,
  taxable_value      integer,
  makes_subscription boolean,   -- a new sale whose payment would file subscription(s)
  subscription_id    uuid,
  plan               text,
  seats              integer,
  renewal_date       date,
  lines              jsonb,
  currency           text,      -- R-2466: the document's currency (INR when none)
  fx_rate            numeric    -- R-2466: ₹ per unit when foreign (the invoice's, else its quote's), else null
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_caller  uuid;
  v_trusted boolean;
begin
  /* R-1838 / §17c: fail closed for a login with no company. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;
  if v_caller is null then
    select c.tenant_id into v_caller from public.customers c where c.id = p_customer_id;
  end if;

  return query
  /* Open quotes with no invoice yet. A quote with an invoice is listed by its invoice below. */
  with q as (
    select qq.*,
           coalesce(
             (select s.id from public.subscriptions s
               where s.tenant_id = qq.tenant_id and s.renewal_quote_id = qq.id limit 1),
             qq.renewal_subscription_id) as r_sub_id,
           upper(coalesce(nullif(btrim(qq.currency), ''), 'INR')) as cur
      from public.quotes qq
     where qq.tenant_id = v_caller
       and qq.customer_id = p_customer_id
       and qq.status in ('sent', 'viewed', 'accepted')
       and qq.superseded_by is null
       and qq.invoice_id is null
       and coalesce(qq.payment_status::text, 'none') in ('none', 'awaiting', 'partial')
       and coalesce(qq.amount, 0) > 0
  )
  select case
           when q.r_sub_id is not null or q.is_renewal or q.is_extension then 'renewal'
           when q.is_add_seats then 'add_seats'
           when q.is_one_off then 'one_off'
           else 'new'
         end,
         q.id, null::text, q.created_date,
         public.quote_open_balance(q.id),
         coalesce(q.subtotal, 0)::integer,
         (q.r_sub_id is null and not q.is_renewal and not q.is_extension and not q.is_add_seats
          and not q.is_one_off
          and not exists (select 1 from public.subscriptions s where s.tenant_id = q.tenant_id and s.quote_id = q.id)
          and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end) li
                       where jsonb_typeof(li) = 'object' and public.quote_line_is_subscription(li, q.tenant_id, false))),
         coalesce(q.r_sub_id, q.add_seats_subscription_id),
         coalesce(s.plan, q.plan), coalesce(s.seats, q.seats), s.renewal_date,
         case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end,
         q.cur,
         case when q.cur <> 'INR' and coalesce(q.exchange_rate, 0) > 0 then q.exchange_rate end
    from q
    left join public.subscriptions s
      on s.tenant_id = q.tenant_id and s.id = coalesce(q.r_sub_id, q.add_seats_subscription_id)
   where public.quote_open_balance(q.id) > 0

  union all

  /* Unpaid invoices — R-1561 due (net_payable − paid_amount). Project-milestone invoices are paid
     through project payments. R-2466: an imported Zoho opening invoice (no quote) is listed — it
     takes its receipt through _record_opening_invoice_payment. Any other invoice with neither a
     quote nor an instalment link has no payment path at all (a payment needs its quote,
     trg_payments_opening_invoice), so it is left out.
     R-2542: an FY sale imported from Zoho (zoho_invoice_id, never a quote) is listed the same way —
     R-2501's rule for a quote-less receipt. */
  select case when i.document_kind = 'opening_invoice' or (i.zoho_invoice_id is not null and i.quote_id is null) then 'opening'
              when i.quote_id is null then 'instalment'
              else 'invoice' end,
         i.quote_id, i.id, i.invoice_date,
         greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0))::integer,
         coalesce(i.taxable_value, 0)::integer,
         false,
         coalesce(sb.subscription_id,
                  (select s2.id from public.subscriptions s2
                    where s2.tenant_id = i.tenant_id and s2.renewal_quote_id = i.quote_id limit 1)),
         s.plan, s.seats, s.renewal_date,
         coalesce(qi.line_items, '[]'::jsonb),
         fx.cur,
         case when fx.cur <> 'INR'
              then coalesce(i.fx_rate,   -- reconcile_bank_credit_fx_invoice's own rule (no nullif): 0 = no rate there too
                            case when upper(coalesce(qi.currency, '')) = fx.cur and coalesce(qi.exchange_rate, 0) > 0 then qi.exchange_rate end)
         end
    from public.invoices i
    left join lateral (select b.subscription_id from public.subscription_billings b
                        where b.tenant_id = i.tenant_id and b.invoice_id = i.id limit 1) sb on true
    left join public.quotes qi on qi.tenant_id = i.tenant_id and qi.id = i.quote_id
    left join public.subscriptions s
      on s.tenant_id = i.tenant_id
     and s.id = coalesce(sb.subscription_id, qi.renewal_subscription_id, qi.add_seats_subscription_id)
    cross join lateral (select upper(coalesce(nullif(btrim(i.currency), ''), nullif(btrim(qi.currency), ''), 'INR')) as cur) fx
   where i.tenant_id = v_caller
     and i.customer_id = p_customer_id
     and i.status in ('pending', 'overdue')
     and i.written_off_at is null
     and (i.quote_id is not null or sb.subscription_id is not null
          or ((i.document_kind = 'opening_invoice' or i.zoho_invoice_id is not null) and i.quote_id is null))   -- R-2466, R-2542
     and not exists (select 1 from public.project_milestones m where m.invoice_id = i.id)
     and coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0) > 0
   order by 4 desc, 2;
end;
$$;

revoke all on function public.bank_credit_open_items(uuid) from public, anon;
grant execute on function public.bank_credit_open_items(uuid) to authenticated, service_role;

-- ── 3. bank_credit_pay_item (from 20261030123423_r2095_sale_invoice_on_receipt) ───────────────────
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
   on the invoice's taxable value (the quote path's rule), not on the GST-inclusive receipt. */
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
           i.amount, i.net_payable, i.paid_amount into v_inv
      from public.invoices i where i.id = p_invoice_id;
    if not found or v_inv.tenant_id is distinct from v_txn.tenant_id then
      raise exception 'Invoice % not found in your company', p_invoice_id using errcode = 'no_data_found';
    end if;
    /* R-2542: a quote-less receipt checks the status AFTER its replay (below) — a line un-reconciled
       (receipt kept) from an invoice it paid in full is matched back to that receipt, not refused. */
    if v_inv.status not in ('pending', 'overdue')
       and not ((v_inv.document_kind = 'opening_invoice' or v_inv.zoho_invoice_id is not null) and v_inv.quote_id is null) then
      raise exception 'Invoice % is %, so there is nothing left to pay on it.', p_invoice_id, v_inv.status using errcode = 'check_violation';
    end if;

    /* R-2466: an imported Zoho opening invoice — its receipt carries the invoice, no quote.
       R-2542: an FY sale imported from Zoho too. */
    if (v_inv.document_kind = 'opening_invoice' or v_inv.zoho_invoice_id is not null) and v_inv.quote_id is null then
      select i.id, i.tenant_id, i.status, i.amount, i.net_payable, i.paid_amount, i.taxable_value into v_inv
        from public.invoices i where i.id = p_invoice_id and i.tenant_id = v_txn.tenant_id for update;
      v_note := 'Bank credit of ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ' matched to ' || p_invoice_id;
      v_due := greatest(0, coalesce(v_inv.net_payable, v_inv.amount, 0) - coalesce(v_inv.paid_amount, 0))::int;

      /* The same receipt again (this reference already on it): that receipt — booked once. */
      select p.id, p.receipt_voucher_no into v_quote
        from public.payments p
       where p.tenant_id = v_txn.tenant_id and p.invoice_id = p_invoice_id and p.quote_id is null
         and p.reference = p_reference and p.status = 'received'
       order by p.received_at limit 1;
      if found then
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

      v_res := public._record_opening_invoice_payment(
        v_txn.tenant_id, p_invoice_id, p_amount + v_tds, 'bank_transfer', p_reference, v_note,
        v_txn.txn_date, v_txn.bank_account_id,
        v_tds, case when v_tds > 0 then coalesce(nullif(v_inv.taxable_value, 0), 0) else 0 end,   -- R-2542: TDS gross = taxable
        case when v_tds > 0 then coalesce(p_tds_section, '194J') end, case when v_tds > 0 then p_tds_rate_pct end,
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
    v_gross := coalesce(v_inv_taxable, nullif(v_quote.subtotal, 0), round(coalesce(v_quote.amount, 0) * 100.0 / (100 + coalesce(v_quote.tax_rate, 18)))::int);

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
    v_gross := coalesce(v_inv_taxable, 0);
  end if;

  /* NOT 'Reconciled from bank receipt': that note marks a throw-away one-off sale which
     unreconcile_bank_receipt may delete ("undo the sale"). A renewal / add-seats / subscription
     payment must never be deleted from the bank page — un-reconciling only frees the line. */
  v_note := 'Bank credit of ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ' matched to ' || coalesce(p_invoice_id, v_quote_id);

  if v_kind = 'instalment' then
    v_res := public.record_instalment_payment(
      p_invoice_id, p_amount + v_tds, 'bank_transfer', p_reference, v_note,
      null, 0, v_txn.txn_date, v_txn.bank_account_id,
      v_tds, case when v_tds > 0 then v_gross else 0 end, case when v_tds > 0 then p_amount else 0 end,
      case when v_tds > 0 then coalesce(p_tds_section, '194J') end, case when v_tds > 0 then p_tds_rate_pct end,
      null, case when v_tds > 0 then public.indian_fiscal_year(v_txn.txn_date) end);
  else
    v_res := public.record_desk_payment(
      v_quote_id, p_amount + v_tds, 'bank_transfer', p_reference, v_note,
      null, 0, v_txn.txn_date, v_txn.bank_account_id,
      v_tds, case when v_tds > 0 then v_gross else 0 end, case when v_tds > 0 then p_amount else 0 end,
      case when v_tds > 0 then coalesce(p_tds_section, '194J') end, case when v_tds > 0 then p_tds_rate_pct end,
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
