-- deploy-peek: to_regprocedure('public.settle_quote_part_short(text,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.settle_quote_part_short(text,text)') and prosrc like '%R-2595%')
-- deploy-key: r2595settlequotepartshort
--
-- R-2595 (8 Nov 2026, follow-up of R-2587; Pardeep OK 8 Nov to the small-short rule). Staging
-- Q-A378-27-0021, billed quarterly: Part 1 ₹95,993, the bank brought ₹95,933. The quote said
-- "Part 1 of 4 received (₹60 short)" with only "Record ₹60 balance" — no way to close the ₹60.
--
-- settle_quote_part_short(quote, reason) — NEW. Money rule P7 (Pardeep OK 8 Nov: ≤ 1% of the part,
-- max ₹500). It writes the same rows as R-2098's reconcile_bank_credit_split with "round-off" for a line
-- that settles more than came in (money-rules S2) — only the limit is P7's, not R-2098's ₹50. It is a
-- SMALL DIFFERENCE (round-off), not a "bank charge" in the S3/S4 sense: a domestic NEFT has no bank
-- deduction (R-2577), so no expense / bank-charge row is written and no remittance check is needed:
--   1. a ₹X receipt on the quote through record_instalment_payment on the part's invoice (reference
--      BANKCHG-<line>, dated the bank line's date, that line's bank account) → the part invoice is paid
--      in full, the quote's received = the part's gross, the next part's invoice / request untouched;
--   2. the original receipt and the ₹X receipt both get payments.bank_txn_id = the line (R-2098 split
--      line → both banked: balance sheet "not yet in bank" 0, cash = the line);
--   3. bank_receipt_round_offs +X on the line → P&L "Bank Charges · Settlement short of receipt"
--      (report_settlement_shortfalls). Dr round-off X / Cr Debtors X; cash unchanged.
-- Allowed only when (refused with a plain message otherwise):
--   • owner or accountant of the quote's company (tenant fail-closed) — as W2's small write-off;
--   • the quote is billed in parts (monthly / quarterly / half-yearly) and its earliest unpaid part
--     invoice is part-paid (≥ ₹1 in) with X = net_payable − paid_amount ≤ the small-short limit
--     (lib/quotes/instalment-status.ts isSmallShort: 1% of the part, max ₹500, at least ₹1);
--   • no credit note / write-off on that invoice; X does not look like TDS (1/2/5/10% of the part's
--     taxable, ±₹2 — R-2577's / tdsRateFor's rates and tolerance);
--   • no LATER part has money in (so the quote's latest receipt is the one that paid this part), and
--     that receipt is matched alone to a money-in bank line (not a split line, no round-off on it yet;
--     line locked) whose credit is exactly the receipt's cash (no advance used, no TDS, no gateway fee)
--     — a receipt not yet in the bank is matched first.
-- Settling twice: the second call finds no short → refused. Undo: un-reconciling the line removes the
-- round-off and unlinks both receipts (R-2098 trigger); the ₹X receipt (BANKCHG-<line>) must then be
-- reversed by hand — a one-click undo is a follow-up card.
-- Test: supabase/tests/r2595_settle_quote_part_short.test.sql (begin … rollback; red without this file).

begin;

create or replace function public.settle_quote_part_short(p_quote_id text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2595: settle a small shortfall on a received part of a quote billed in parts as a round-off (P7). */
declare
  c_max     constant integer := 500;   -- isSmallShort: SMALL_SHORT_MAX
  c_pct     constant integer := 1;     -- isSmallShort: SMALL_SHORT_PCT
  v_tenant  uuid := public.current_tenant_id();
  v_q       record;
  v_inv     record;
  v_gross   integer;
  v_short   integer;
  v_limit   integer;
  v_taxable integer;
  v_pay     record;
  v_txn     record;
  v_ref     text;
  v_res     jsonb;
  v_new_id  uuid;
  v_r       integer;
begin
  if v_tenant is null then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can settle a small difference.' using errcode = '42501';
  end if;

  select q.id, q.tenant_id, q.billing_cycle::text as billing_cycle, q.tax_rate
    into v_q
    from public.quotes q
   where q.id = p_quote_id and q.tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'Quote % was not found in your company. Refresh the page.', p_quote_id using errcode = '42501';
  end if;
  if coalesce(v_q.billing_cycle, '') not in ('monthly', 'quarterly', 'half_yearly') then
    raise exception 'Quote % is not billed in parts — record the balance or follow it up instead.', v_q.id using errcode = '22023';
  end if;

  /* The earliest part invoice still open (payments are applied to the parts in order — P3). */
  select i.id, i.status::text as status, i.net_payable, i.amount, i.paid_amount, i.taxable_value, i.written_off_at,
         b.term_start, b.period_index
    into v_inv
    from public.subscriptions s
    join public.subscription_billings b on b.subscription_id = s.id and b.tenant_id = v_tenant
    join public.invoices i on i.id = b.invoice_id and i.tenant_id = v_tenant
   where s.tenant_id = v_tenant and s.quote_id = v_q.id
     and i.status::text in ('pending', 'overdue')
   order by b.term_start, b.period_index, i.id
   limit 1
   for update of i;
  if not found then
    raise exception 'Quote % has no part left with a difference — nothing to settle. Refresh the page.', v_q.id using errcode = '22023';
  end if;
  v_gross := round(coalesce(v_inv.net_payable, v_inv.amount, 0))::int;
  v_short := greatest(0, v_gross - round(coalesce(v_inv.paid_amount, 0))::int);
  if round(coalesce(v_inv.paid_amount, 0)) < 1 or v_short <= 0 then
    raise exception 'Invoice % has no money in yet — there is no small difference to settle. Record the payment when it comes.', v_inv.id
      using errcode = '22023';
  end if;
  v_limit := greatest(1, least(c_max, floor(v_gross * c_pct / 100.0)::int));
  if v_short > v_limit then
    raise exception 'Only a small difference (up to 1%% of the part, max ₹%) can be settled here — ₹% is still due on invoice %. Record the balance or follow it up.',
      v_limit, v_short, v_inv.id using errcode = '22023';
  end if;
  if v_inv.written_off_at is not null
     or exists (select 1 from public.credit_notes cn where cn.tenant_id = v_tenant and cn.invoice_id = v_inv.id) then
    raise exception 'Invoice % has a credit note or a write-off — settle its balance from the invoice instead.', v_inv.id
      using errcode = '22023';
  end if;
  /* A gap that is TDS at a common rate is TDS, not a small difference (money-rules S4, R-2577's
     rates 1/2/5/10 and ±₹2 tolerance). */
  v_taxable := coalesce(nullif(round(v_inv.taxable_value)::int, 0),
                        round(v_gross * 100.0 / (100 + coalesce(v_q.tax_rate, 18)))::int);
  foreach v_r in array array[1, 2, 5, 10] loop
    if abs(v_short - round(v_taxable * v_r / 100.0)::int) <= 2 then
      raise exception '₹% is % %% of the part''s taxable value — that looks like TDS. Record it as TDS with the payment instead.',
        v_short, v_r using errcode = '22023';
    end if;
  end loop;

  /* The receipt that brought the part's money: no later part has money in, so it is the quote's latest. */
  if exists (select 1
               from public.subscriptions s
               join public.subscription_billings b on b.subscription_id = s.id and b.tenant_id = v_tenant
               join public.invoices i on i.id = b.invoice_id and i.tenant_id = v_tenant
              where s.tenant_id = v_tenant and s.quote_id = v_q.id and i.id <> v_inv.id
                and coalesce(i.paid_amount, 0) > 0
                and (b.term_start, b.period_index) > (v_inv.term_start, v_inv.period_index)) then
    raise exception 'A later part of quote % already has money in — settle the ₹% on Banking → Reconcile, on the line that brought it.', v_q.id, v_short
      using errcode = '22023';
  end if;
  select p.* into v_pay
    from public.payments p
   where p.tenant_id = v_tenant and p.quote_id = v_q.id and p.status = 'received'
   order by p.received_at desc, p.created_at desc
   limit 1;
  select t.id, t.credit, t.txn_date, t.bank_account_id, t.matched_to_type, t.matched_to_id into v_txn
    from public.bank_transactions t
   where t.tenant_id = v_tenant and t.matched_to_type = 'payment' and t.matched_to_id = v_pay.id::text
     and coalesce(t.credit, 0) > 0
   limit 1
   for update;
  if v_pay.id is null or v_txn.id is null then
    raise exception 'Match this receipt to its bank line first (Banking → Reconcile) — then settle the ₹% difference.', v_short
      using errcode = '22023';
  end if;
  if v_pay.bank_txn_id is not null
     or exists (select 1 from public.bank_receipt_round_offs r where r.bank_txn_id = v_txn.id) then
    raise exception 'This receipt''s bank line already pays several items or has a round-off — settle the difference on Banking → Reconcile.'
      using errcode = '22023';
  end if;
  if exists (select 1 from public.tds_receivable t where t.tenant_id = v_tenant and t.payment_id = v_pay.id) then
    raise exception 'This receipt has TDS — check whether the ₹% is more TDS before settling it as a small difference.', v_short
      using errcode = '22023';
  end if;
  /* The line must be exactly this receipt's cash — else a gap already in the P&L would vanish. */
  if round(v_txn.credit)::bigint <> (v_pay.amount - coalesce(v_pay.credit_applied, 0))::bigint
     or exists (select 1 from public.expenses e where e.tenant_id = v_tenant and e.id = 'EXP-RZPFEE-' || v_pay.id::text) then
    raise exception 'The bank line (₹%) is not exactly this receipt''s cash — settle the difference on Banking → Reconcile.', round(v_txn.credit)
      using errcode = '22023';
  end if;

  /* 1. the ₹X receipt on the part (record_instalment_payment: applied to THIS invoice). */
  v_ref := 'BANKCHG-' || v_txn.id::text;
  v_res := public.record_instalment_payment(
    v_inv.id, v_short, 'bank_transfer', v_ref,
    left(format('R-2595: ₹%s short on the bank line of %s, settled as small difference (round-off)%s', v_short,
                to_char(v_txn.txn_date, 'DD Mon YYYY'),
                coalesce(' — ' || nullif(btrim(coalesce(p_reason, '')), ''), '')), 500),
    null, 0, v_txn.txn_date, v_txn.bank_account_id);
  v_new_id := nullif(v_res->>'payment_id', '')::uuid;
  if v_new_id is null or coalesce((v_res->>'idempotent_replay')::boolean, false) then
    raise exception 'The small difference was not recorded — nothing was saved. Refresh the page and try again.' using errcode = 'P0001';
  end if;

  /* 2. both receipts on the line (R-2098 split line), 3. the line's round-off = the difference. */
  update public.payments set bank_txn_id = v_txn.id
   where tenant_id = v_tenant and id in (v_pay.id, v_new_id);
  insert into public.bank_receipt_round_offs (tenant_id, bank_txn_id, amount, created_by)
  values (v_tenant, v_txn.id, v_short, auth.uid());

  return jsonb_build_object(
    'quote_id',    v_q.id,
    'invoice_id',  v_inv.id,
    'amount',      v_short,
    'payment_id',  v_new_id,
    'bank_txn_id', v_txn.id);
end;
$$;
revoke all on function public.settle_quote_part_short(text, text) from public, anon;
grant execute on function public.settle_quote_part_short(text, text) to authenticated, service_role;
comment on function public.settle_quote_part_short(text, text) is
  'R-2595 (money rule P7): a part of a quote billed in parts received short by ≤ the small-short limit (1% of the part, max ₹500), no later part paid, whose latest receipt is matched alone to a bank line of exactly its cash → ₹X receipt on the part (BANKCHG-<line>), both receipts on the line, bank_receipt_round_offs +X (P&L Bank Charges · settlement short). Owner/accountant; tenant fail-closed; every other case refused.';

commit;

notify pgrst, 'reload schema';
