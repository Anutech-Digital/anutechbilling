-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_bank_split_line_unmatched()') and prosrc like '%R-2609%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.settle_quote_part_short(text,text)') and prosrc like '%R-2609%') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bank_receipt_round_offs' and column_name = 'invoice_id')
-- deploy-key: r2609undosettledsmallshort
--
-- R-2609 (8 Nov 2026, follow-up of R-2595 — its checker + code-review): un-reconciling a bank line that
-- carries an R-2595 settled small difference takes that settle back too.
--
-- ─── THE GAP ─────────────────────────────────────────────────────────────────────────────────
--   settle_quote_part_short (R-2595, 20261108092350) writes a ₹X receipt BANKCHG-<line> on the part
--   invoice, puts both receipts on the line (payments.bank_txn_id) and a +X round-off. Un-reconciling the
--   line (Undo on Banking → Reconcile, or the line re-matched to something else) ran only R-2098's
--   trigger: round-off deleted, receipts unlinked — but the ₹X receipt stayed. Balance sheet: ₹X "not yet
--   in bank" cash that never existed; the part still read Paid; re-matching the line did not bring the
--   round-off back.
--
-- ─── THE FIX ─────────────────────────────────────────────────────────────────────────────────
--   tg_bank_split_line_unmatched (R-2098's body, the only definition) — before it unlinks the receipts,
--   a received BANKCHG-<this line> receipt on the line is taken back in the SAME transaction:
--     • refused unless owner / accountant (or a trusted session): removing a receipt, as R-1863's advance
--       undo in unreconcile_bank_receipt — manager / billing get a plain message and nothing changes;
--     • refused while the part invoice got a credit note / write-off after the settle (the settle refuses
--       those up front, so any present one came later) — reverse that first;
--     • the receipt goes through delete_payment (R-1568: voucher number kept in cancelled_vouchers, quote
--       received / status and subscription outstanding worked out again);
--     • the part invoice gets the ₹X back as due: paid_amount − X, a paid invoice → pending (overdue past
--       its due date), no paid date. Other parts are untouched.
--   Which part: bank_receipt_round_offs.invoice_id (NEW nullable column) — settle_quote_part_short (R-2595
--   body, only its round-off insert changes) now records the part invoice it settled. A settle made before
--   this file has no invoice_id: then the one part of the quote paid on the settle's date is used, and the
--   undo is refused (nothing changes) when not exactly one part fits — never guessed.
--   Then R-2098's own work: receipts unlinked, round-off removed. Re-matching the line to the original
--   receipt and settling again works (the BANKCHG reference is free again).
--   A plain R-2098 split line (no BANKCHG receipt) is unchanged. Stored data is not changed.
-- Test: supabase/tests/r2609_undo_settled_small_short.test.sql (begin … rollback; red without this file).

begin;

-- ── bank_receipt_round_offs.invoice_id — the part invoice an R-2595 settle closed ──
alter table public.bank_receipt_round_offs
  add column if not exists invoice_id text references public.invoices(id) on delete set null;
comment on column public.bank_receipt_round_offs.invoice_id is
  'R-2609: set by settle_quote_part_short (R-2595) — the part invoice its ₹X BANKCHG receipt settled; un-reconciling the line gives the ₹X back to it. Null for R-2098 / R-2192 round-offs.';

-- ── settle_quote_part_short — R-2595 body (20261108092350), the round-off row now names its invoice ──
create or replace function public.settle_quote_part_short(p_quote_id text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2595: settle a small shortfall on a received part of a quote billed in parts as a round-off (P7).
   R-2609: the round-off row names the part invoice it settled, so un-reconciling the line gives the ₹X back to it. */
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
  insert into public.bank_receipt_round_offs (tenant_id, bank_txn_id, amount, created_by, invoice_id)  -- R-2609: + invoice_id
  values (v_tenant, v_txn.id, v_short, auth.uid(), v_inv.id);

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

-- ── tg_bank_split_line_unmatched — R-2098 body (20261029054707, its only definition) + the R-2609 undo ──
create or replace function public.tg_bank_split_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bc   public.payments;   -- R-2609: the R-2595 settled small difference on this line
  v_inv  record;
  v_left integer;
  v_inv_id text;
  v_n    integer;
begin
  /* R-2098: the line no longer carries its receipts — they are undeposited again, and the
     written-off difference is no longer a settlement difference.
     R-2609: an R-2595 small difference settled on this line (receipt BANKCHG-<line>) is taken back
     with it — receipt removed, the part invoice owes the ₹X again. */
  if old.matched_to_type is not distinct from new.matched_to_type
     and old.matched_to_id is not distinct from new.matched_to_id then
    return new;
  end if;

  select p.* into v_bc
    from public.payments p
   where p.tenant_id = old.tenant_id and p.bank_txn_id = old.id
     and p.reference = 'BANKCHG-' || old.id::text and p.status = 'received'
   limit 1
   for update;
  if found then
    if not (coalesce(public.current_request_role(), '') = 'service_role'
            or (public.current_request_role() is null
                and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
       and not public.current_user_has_role('owner', 'accountant') then
      raise exception 'Un-reconciling this line also takes back the ₹% small difference settled on quote % (receipt BANKCHG). Only an owner or accountant can remove a receipt — ask them to un-reconcile this line.',
        v_bc.amount, v_bc.quote_id using errcode = '42501';
    end if;
    /* The part invoice the settle closed: named on the round-off row (since R-2609). A row settled
       before that has none — then the one part of the quote paid on the settle's date, only when
       exactly one fits; otherwise refused rather than guessed. */
    select r.invoice_id into v_inv_id
      from public.bank_receipt_round_offs r
     where r.bank_txn_id = old.id and r.invoice_id is not null
     limit 1;
    if v_inv_id is null then
      select min(i.id), count(*) into v_inv_id, v_n
        from public.subscriptions s
        join public.subscription_billings b on b.subscription_id = s.id and b.tenant_id = old.tenant_id
        join public.invoices i on i.id = b.invoice_id and i.tenant_id = old.tenant_id
       where s.tenant_id = old.tenant_id and s.quote_id = v_bc.quote_id
         and i.status::text = 'paid' and i.paid_date = v_bc.received_at::date
         and coalesce(i.paid_amount, 0) >= v_bc.amount;
      if v_n <> 1 then v_inv_id := null; end if;
    end if;
    select i.id, i.status::text as status, i.amount, i.net_payable, i.paid_amount, i.due_date, i.written_off_at
      into v_inv
      from public.invoices i
     where i.id = v_inv_id and i.tenant_id = old.tenant_id
     for update;
    if not found then
      raise exception 'The ₹% small difference settled on this line cannot be matched to one part of quote % — nothing was changed. Ask your accountant to check receipt BANKCHG on that quote.',
        v_bc.amount, v_bc.quote_id using errcode = 'check_violation';
    end if;
    if v_inv.written_off_at is not null
       or exists (select 1 from public.credit_notes cn where cn.tenant_id = old.tenant_id and cn.invoice_id = v_inv.id) then
      raise exception 'Invoice % got a credit note or a write-off after its ₹% small difference was settled on this line. Reverse that first (the invoice page), then un-reconcile this line.',
        v_inv.id, v_bc.amount using errcode = 'check_violation', hint = '/invoices/' || v_inv.id;
    end if;

    update public.payments set bank_txn_id = null where id = v_bc.id;
    perform public.delete_payment(v_bc.id);

    v_left := greatest(0, round(coalesce(v_inv.paid_amount, 0))::int - v_bc.amount);
    update public.invoices i
       set paid_amount = v_left,
           status = case when v_inv.status = 'paid' and v_left < coalesce(v_inv.net_payable, v_inv.amount)
                         then case when v_inv.due_date < public.ist_today() then 'overdue' else 'pending' end::invoice_status
                         else i.status end,
           paid_date = case when v_left < coalesce(v_inv.net_payable, v_inv.amount) then null else i.paid_date end,
           updated_at = now()
     where i.id = v_inv.id and i.tenant_id = old.tenant_id;
  end if;

  update public.payments set bank_txn_id = null
   where tenant_id = old.tenant_id and bank_txn_id = old.id;
  delete from public.bank_receipt_round_offs where bank_txn_id = old.id;
  return new;
end;
$$;
revoke all on function public.tg_bank_split_line_unmatched() from public, anon, authenticated;

commit;
