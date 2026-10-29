-- deploy-peek: to_regprocedure('public.reconcile_bank_credit_split(uuid,uuid,jsonb,jsonb,text)') is not null and to_regclass('public.bank_receipt_round_offs') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.report_balance_sheet(date)') and prosrc like '%R-2098%')
-- deploy-key: r2098bankcreditsplit
-- 20261029054707_r2098_bank_credit_split.sql
--
-- R-2098 (29 Oct 2026, from the R-2094 staging reconcile): one bank credit often pays SEVERAL
-- things of one customer — I-XL ₹11,718 = 3 invoices, Infotrack ₹1,15,710 = 8 invoices + ₹346
-- left over, Vikas ₹13,087 = Q-0044's ₹169 + a new ₹12,918 sale, Subi Exports ₹16,236 = ₹48
-- short (Zoho: "Payment Adjustment"). Banking → Reconcile could book a line on ONE item only.
--
-- ─── WHAT CHANGES ────────────────────────────────────────────────────────────────────────
--   payments.bank_txn_id       the bank line a receipt came in on when ONE line carries several
--                              receipts (project_payments.bank_txn_id is the same idea, R-1999).
--                              The line itself stays matched_to_type 'payment' → its first
--                              receipt, so every existing reader (row label, un-reconcile, refund
--                              un-matching) keeps working; the other receipts hang on bank_txn_id.
--   bank_receipt_round_offs    the small difference (≤ ₹50) the owner wrote off on such a line:
--                              amount > 0 = less came in than was settled (bank / round-off
--                              charge), < 0 = a little more came in (round-off gain).
--   trg_bank_split_line_unmatched  the line un-reconciled / re-matched → its receipts lose
--                              bank_txn_id (they are "received, not yet in bank" again — the same
--                              as a single receipt whose line is un-reconciled) and its round-off
--                              row goes.
--   bank_credit_pay_item / bank_credit_book_advance / bank_credit_new_sale_quote
--                              the bodies of reconcile_bank_credit_to_item (R-2044 version),
--                              reconcile_bank_credit_as_advance (R-1863) and
--                              reconcile_bank_credit_new_sale (R-2026) WITHOUT the line lock and
--                              the reconcile, and with the amount as an argument. The three public
--                              RPCs now call them — same guards, same order, same result. Not
--                              callable by a login (service_role only).
--   reconcile_bank_credit_split(txn, customer, items, sale, rest)
--                              ONE transaction: each item {quote_id | invoice_id, amount} is paid
--                              through bank_credit_pay_item → record_desk_payment /
--                              record_instalment_payment (exactly as if paid on its own: renewal,
--                              seats, subscription, GST invoice when fully paid); an optional new
--                              sale is made (bank_credit_new_sale_quote) and paid the same way;
--                              money left over → the customer's advance (bank_credit_book_advance,
--                              R-1863's receipt + customer credit) or, ≤ ₹50, a round-off; a
--                              shortfall ≤ ₹50 → a round-off (every item is still settled in full).
--                              Over-allocation beyond that is refused. One UTR on several receipts
--                              via app.payment_ref_batch (R-1676, as record_multi_invoice_payment).
--                              Double-click: the second call finds the line reconciled — refused,
--                              nothing written twice.
--   report_settlement_shortfalls  the round-off rows are the line's settlement difference — the
--                              P&L's existing "Bank Charges · Settlement short of receipt" (a gain
--                              is a negative charge). Split receipts are left out of the per-
--                              payment comparison (their line carries several).
--   report_balance_sheet       a receipt on a split line is banked, not undeposited.
--
-- Not changed: the single-item / new-sale / advance flows (same RPCs, same results), GST
-- (each receipt is cash, credit_applied 0 — 11A/11B as for separate payments), payments' own
-- triggers. Test: supabase/tests/r2098_bank_credit_split.test.sql

begin;

-- ── 1. The link, the round-off, the unlink trigger ─────────────────────────────────────────
alter table public.payments
  add column if not exists bank_txn_id uuid references public.bank_transactions(id) on delete set null;
create index if not exists payments_bank_txn_id_idx on public.payments (bank_txn_id) where bank_txn_id is not null;
comment on column public.payments.bank_txn_id is
  'R-2098: the bank line this receipt came in on when one line carries several receipts (Reconcile → several items). The line''s matched_to_id names its first receipt. Cleared when the line is un-reconciled.';

create table if not exists public.bank_receipt_round_offs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  bank_txn_id uuid not null unique references public.bank_transactions(id) on delete cascade,
  amount      integer not null check (amount <> 0 and abs(amount) <= 1000),
  created_by  uuid,
  created_at  timestamptz not null default now()
);
comment on table public.bank_receipt_round_offs is
  'R-2098: the small difference written off when one bank credit settled several items. amount > 0 = settled more than came in (bank / round-off charge); < 0 = a little more came in (round-off gain). Read by report_settlement_shortfalls (P&L Bank Charges).';
alter table public.bank_receipt_round_offs enable row level security;
drop policy if exists bank_receipt_round_offs_tenant_read on public.bank_receipt_round_offs;
create policy bank_receipt_round_offs_tenant_read on public.bank_receipt_round_offs
  for select to authenticated using (tenant_id = (select public.current_tenant_id()));
-- Cloud SQL has no BYPASSRLS: the service role needs its own policy.
drop policy if exists zzz_service_role_all on public.bank_receipt_round_offs;
create policy zzz_service_role_all on public.bank_receipt_round_offs as permissive for all to service_role
  using (true) with check (true);
revoke all on table public.bank_receipt_round_offs from anon;
grant select on table public.bank_receipt_round_offs to authenticated;
grant all on table public.bank_receipt_round_offs to service_role;

create or replace function public.tg_bank_split_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-2098: the line no longer carries its receipts — they are undeposited again, and the
     written-off difference is no longer a settlement difference. */
  if old.matched_to_type is not distinct from new.matched_to_type
     and old.matched_to_id is not distinct from new.matched_to_id then
    return new;
  end if;
  update public.payments set bank_txn_id = null
   where tenant_id = old.tenant_id and bank_txn_id = old.id;
  delete from public.bank_receipt_round_offs where bank_txn_id = old.id;
  return new;
end;
$$;
revoke all on function public.tg_bank_split_line_unmatched() from public, anon, authenticated;

drop trigger if exists trg_bank_split_line_unmatched on public.bank_transactions;
create trigger trg_bank_split_line_unmatched
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_bank_split_line_unmatched();

-- ── 2. bank_credit_pay_item — reconcile_bank_credit_to_item's body (R-2044), amount given ──
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
/* R-2098: one item paid from a bank credit — no line lock, no reconcile (the caller does both).
   Called by reconcile_bank_credit_to_item (amount = the whole credit) and
   reconcile_bank_credit_split (amount = the item's share). */
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
    select i.id, i.tenant_id, i.quote_id, i.taxable_value, i.status into v_inv
      from public.invoices i where i.id = p_invoice_id;
    if not found or v_inv.tenant_id is distinct from v_txn.tenant_id then
      raise exception 'Invoice % not found in your company', p_invoice_id using errcode = 'no_data_found';
    end if;
    if v_inv.status not in ('pending', 'overdue') then
      raise exception 'Invoice % is %, so there is nothing left to pay on it.', p_invoice_id, v_inv.status using errcode = 'check_violation';
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

  /* Invoice once fully paid, when the quote has none (record_payment never issues one). */
  if v_quote_id is not null and not v_replay then
    select q.invoice_id into v_inv_now from public.quotes q where q.id = v_quote_id;
    if v_inv_now is null
       and coalesce((v_res->>'is_fully_paid')::boolean, false)
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

-- The result the sheet shows for one paid item (reconcile_bank_credit_to_item's own shape).
create or replace function public.bank_credit_item_result(p_tenant_id uuid, p_core jsonb, p_invoice_id text, p_amount integer, p_tds integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_res      jsonb := p_core->'res';
  v_kind     text := p_core->>'kind';
  v_quote_id text := p_core->>'quote_id';
  v_sub_id   uuid := nullif(p_core->>'sub_id', '')::uuid;
  v_subs     jsonb;
begin
  /* R-2098: what happened, for the result panel — moved unchanged out of
     reconcile_bank_credit_to_item. */
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'plan', s.plan, 'seats', s.seats, 'start_date', s.start_date,
           'renewal_date', s.renewal_date, 'billing_cycle', s.billing_cycle) order by s.created_at), '[]'::jsonb)
    into v_subs
    from public.subscriptions s
   where s.tenant_id = p_tenant_id
     and (s.id = v_sub_id or (v_kind in ('new', 'one_off') and v_quote_id is not null and s.quote_id = v_quote_id));

  return jsonb_build_object(
    'kind',                 v_kind,
    'quote_id',             v_quote_id,
    'invoice_id',           coalesce(p_invoice_id, p_core->>'invoice_issued', (select q.invoice_id from public.quotes q where q.id = v_quote_id)),
    'invoice_issued',       p_core->>'invoice_issued',
    'payment_id',           nullif(p_core->>'payment_id', '')::uuid,
    'receipt_voucher_no',   v_res->>'receipt_voucher_no',
    'amount',               p_amount,
    'tds_amount',           p_tds,
    'outstanding',          coalesce((v_res->>'outstanding')::int, 0),
    'is_fully_paid',        coalesce((v_res->>'is_fully_paid')::boolean, false),
    'overpaid_credit',      coalesce((v_res->>'overpaid_credit')::int, 0),
    'renewal_rolled_forward', coalesce((v_res->>'renewal_rolled_forward')::boolean, false),
    'subscription_skipped', coalesce((p_core->>'skip_sub')::boolean, false),
    'already_recorded',     coalesce((p_core->>'replay')::boolean, false),
    'subscriptions',        v_subs
  );
end;
$$;
revoke all on function public.bank_credit_item_result(uuid, jsonb, text, integer, integer) from public, anon, authenticated;
grant execute on function public.bank_credit_item_result(uuid, jsonb, text, integer, integer) to service_role;

-- ── 3. reconcile_bank_credit_to_item — same guards, same result; the body is §2 ────────────
create or replace function public.reconcile_bank_credit_to_item(
  p_txn_id              uuid,
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
declare
  v_caller     uuid;
  v_trusted    boolean;
  v_txn        record;
  v_ref        text;
  v_core       jsonb;
  v_pay_id     uuid;
  v_quote_id   text;
begin
  /* §17c fail-closed + R-718 money roles. R-2044: no whole invoice for a part request.
     R-2098: the payment itself is bank_credit_pay_item (shared with the split). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;
  if (p_quote_id is null) = (p_invoice_id is null) then
    raise exception 'Pick one quote or one invoice this money is for.' using errcode = '22023';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can pay a quote or invoice.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  /* The line's UTR is the payment reference (record_payment replays on quote + reference). */
  v_ref := coalesce(nullif(btrim(v_txn.reference), ''), 'BANK-' || v_txn.id::text);
  v_core := public.bank_credit_pay_item(
    p_txn_id, v_txn.credit, v_ref, p_quote_id, p_invoice_id, p_tds_amount, p_tds_rate_pct, p_tds_section,
    p_create_subscription, p_sub_start, p_sub_renewal);
  v_pay_id := (v_core->>'payment_id')::uuid;
  v_quote_id := v_core->>'quote_id';

  /* Already recorded by hand with this UTR: reconcile this line to THAT payment, never a second
     one — unless another bank line already carries it. */
  if coalesce((v_core->>'replay')::boolean, false)
     and exists (select 1 from public.bank_transactions t
                  where t.tenant_id = v_txn.tenant_id and t.id <> v_txn.id
                    and t.matched_to_type = 'payment' and t.matched_to_id = v_pay_id::text) then
    raise exception 'A payment with reference % is already recorded on % and reconciled to another bank line. Nothing was changed.', v_ref, v_quote_id
      using errcode = 'unique_violation';
  end if;

  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_pay_id::text, 'manual');

  return public.bank_credit_item_result(v_txn.tenant_id, v_core, p_invoice_id, v_txn.credit, greatest(0, coalesce(p_tds_amount, 0)));
end;
$$;
revoke all on function public.reconcile_bank_credit_to_item(uuid, text, text, integer, numeric, text, boolean, date, date) from public, anon;
grant execute on function public.reconcile_bank_credit_to_item(uuid, text, text, integer, numeric, text, boolean, date, date) to authenticated, service_role;

-- ── 4. bank_credit_book_advance — R-1863's receipt + credit, amount given ──────────────────
create or replace function public.bank_credit_book_advance(p_txn_id uuid, p_customer_id uuid, p_amount integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2098: reconcile_bank_credit_as_advance's booking without the lock and the reconcile — the
   whole line there, the money left over in reconcile_bank_credit_split. */
declare
  v_txn       record;
  v_cust      record;
  v_export    boolean;
  v_rate      integer;
  v_qid       text;
  v_ref       text;
  v_voucher   text;
  v_pay_id    uuid;
  v_credit_id uuid;
begin
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'An advance must be more than ₹0.' using errcode = '22023';
  end if;
  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  select c.id, c.name, c.country, c.tenant_id into v_cust from public.customers c where c.id = p_customer_id;
  if not found or v_cust.tenant_id is distinct from v_txn.tenant_id then
    raise exception 'Customer not found in your company — pick the customer who paid.' using errcode = 'no_data_found';
  end if;

  /* The advance's GST rate — same rule as create_direct_invoice / reconcile_bank_credit_new_sale. */
  v_export := coalesce(nullif(lower(trim(v_cust.country)), ''), 'india') not in ('india','in','ind','bharat');
  v_rate := case
              when v_export then 0
              when public.supplier_gst_status(v_txn.tenant_id, public.ist_today()) in ('unregistered', 'composition') then 0
              else 18
            end;

  /* The ₹0 holder quote the receipt hangs on (payments need a quote). Nothing to invoice. */
  v_qid := public.next_document_number('quote', v_txn.tenant_id, public.ist_today());
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;
  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, payment_amount, payment_method, payment_reference,
    payment_received_at, is_one_off, billing_cycle, created_date, notes
  ) values (
    v_qid, v_txn.tenant_id, p_customer_id, v_cust.name, 'Advance on account', 0, 0, 0, v_rate, 0,
    '[]'::jsonb, 'accepted', 'received', p_amount, 'bank_transfer',
    coalesce(nullif(btrim(v_txn.reference), ''), 'BANK-' || v_txn.id::text),
    (v_txn.txn_date::timestamp at time zone 'UTC'), true, 'yearly', public.ist_today(),
    'Advance received in the bank on ' || to_char(v_txn.txn_date, 'DD Mon YYYY')
      || ' — kept as customer credit, nothing invoiced yet (R-1863).'
  );

  /* The receipt, as record_payment writes it (voucher from the series, bank date — R-1118). */
  v_ref := coalesce(nullif(btrim(v_txn.reference), ''), 'BANK-' || v_txn.id::text);
  v_voucher := public.next_document_number('receipt_voucher', v_txn.tenant_id, public.ist_today());
  insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
                               status, received_at, receipt_voucher_no, recorded_by, bank_account_id)
  values (v_txn.tenant_id, v_qid, p_customer_id, p_amount, 'bank_transfer', v_ref,
          'Advance on account — bank credit of ' || to_char(v_txn.txn_date, 'DD Mon YYYY'),
          'received', (v_txn.txn_date::timestamp at time zone 'UTC'), v_voucher, auth.uid(), v_txn.bank_account_id)
  returning id into v_pay_id;

  /* The credit, as record_payment writes an overpayment's (same source, same links). */
  insert into public.customer_credits
    (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, note, status)
  values
    (v_txn.tenant_id, p_customer_id, p_amount, 'overpayment', v_pay_id, v_qid,
     'Advance received ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ' (bank) — nothing invoiced yet', 'open')
  returning id into v_credit_id;

  return jsonb_build_object('quote_id', v_qid, 'payment_id', v_pay_id, 'receipt_voucher_no', v_voucher,
                            'credit_id', v_credit_id, 'customer_name', v_cust.name);
end;
$$;
revoke all on function public.bank_credit_book_advance(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.bank_credit_book_advance(uuid, uuid, integer) to service_role;

create or replace function public.reconcile_bank_credit_as_advance(p_txn_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller    uuid;
  v_trusted   boolean;
  v_txn       record;
  v_cust      record;
  v_adv       jsonb;
begin
  /* R-1863 / §17c fail-closed + R-718 money roles. R-2098: the booking is bank_credit_book_advance. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can be a customer''s advance.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  select c.id, c.name, c.country, c.tenant_id into v_cust from public.customers c where c.id = p_customer_id;
  if not found or v_cust.tenant_id is distinct from v_txn.tenant_id then
    raise exception 'Customer not found in your company — pick the customer who paid.' using errcode = 'no_data_found';
  end if;

  v_adv := public.bank_credit_book_advance(p_txn_id, p_customer_id, v_txn.credit);

  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_adv->>'payment_id', 'manual');

  return jsonb_build_object(
    'kind',               'advance',
    'quote_id',           v_adv->>'quote_id',
    'payment_id',         (v_adv->>'payment_id')::uuid,
    'receipt_voucher_no', v_adv->>'receipt_voucher_no',
    'credit_id',          (v_adv->>'credit_id')::uuid,
    'customer_id',        p_customer_id,
    'customer_name',      v_cust.name,
    'amount',             v_txn.credit,
    'advance_credit',     v_txn.credit,
    'tds_amount',         0,
    'outstanding',        0,
    'is_fully_paid',      true,
    'overpaid_credit',    0,
    'subscriptions',      '[]'::jsonb
  );
end;
$$;
revoke all on function public.reconcile_bank_credit_as_advance(uuid, uuid) from public, anon;
grant execute on function public.reconcile_bank_credit_as_advance(uuid, uuid) to authenticated, service_role;

-- ── 5. bank_credit_new_sale_quote — R-2026's sale quote, made without paying it ─────────────
create or replace function public.bank_credit_new_sale_quote(
  p_txn_id        uuid,
  p_customer_id   uuid,
  p_lines         jsonb,
  p_billing_cycle text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2098: reconcile_bank_credit_new_sale's quote, moved here unchanged so the split can make the
   same sale and pay part of the line on it. Returns {quote_id, quote_total, tax_rate}. */
declare
  v_cycle    text;
  v_txn      record;
  v_cust     record;
  v_export   boolean;
  v_rate     integer;
  v_lines    jsonb;
  v_subtotal integer;
  v_gross    integer;
  v_qid      text;
  v_monthly  boolean;
  v_annual   boolean;
  v_problem  text;
  v_seats    integer;
begin
  select t.id, t.tenant_id, t.credit, t.txn_date, t.matched_to_type into v_txn
    from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;

  select c.id, c.name, c.country, c.tenant_id into v_cust from public.customers c where c.id = p_customer_id;
  if not found or v_cust.tenant_id is distinct from v_txn.tenant_id then
    raise exception 'Customer not found in your company' using errcode = 'no_data_found';
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add what was sold — at least one product line.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) li
              where jsonb_typeof(li) <> 'object'
                 or nullif(btrim(coalesce(li->>'name', '')), '') is null
                 or coalesce(li->>'qty', '') !~ '^[0-9]+$' or (li->>'qty')::int <= 0
                 or coalesce(li->>'rate', '') !~ '^[0-9]+$'
                 or coalesce(li->>'commitment', 'one_time') not in ('annual_yearly', 'monthly', 'one_time')) then
    raise exception 'Every line needs a product, seats / quantity of at least 1 and a whole-rupee unit price.' using errcode = '22023';
  end if;
  v_monthly := exists (select 1 from jsonb_array_elements(p_lines) li where li->>'commitment' = 'monthly');
  v_annual  := exists (select 1 from jsonb_array_elements(p_lines) li where li->>'commitment' = 'annual_yearly');
  if v_monthly and v_annual then
    raise exception 'One quote = one billing term. Put monthly items on a separate sale.' using errcode = 'check_violation';
  end if;

  /* R-2026: how often it is billed — the quote builder's rule. Monthly flex has no commitment,
     so it is billed monthly only; an annual commitment is billed yearly, half-yearly, quarterly
     or monthly; a one-time sale is not split. */
  v_cycle := nullif(btrim(coalesce(p_billing_cycle, '')), '');
  if v_cycle is not null and v_cycle not in ('yearly', 'half_yearly', 'quarterly', 'monthly') then
    raise exception 'Payment must be yearly, half-yearly, quarterly or monthly.' using errcode = '22023';
  end if;
  if v_monthly then
    if v_cycle is not null and v_cycle <> 'monthly' then
      raise exception 'A Monthly flex plan has no commitment, so it is billed monthly only.' using errcode = 'check_violation';
    end if;
    v_cycle := 'monthly';
  elsif not v_annual then
    v_cycle := 'yearly';
  else
    v_cycle := coalesce(v_cycle, 'yearly');
  end if;

  /* Same refusals and tax rule as create_direct_invoice. */
  v_problem := public.supplier_invoice_problem(v_txn.tenant_id, public.ist_today());
  if v_problem is not null then
    raise exception '%', v_problem using errcode = 'check_violation';
  end if;
  v_export := coalesce(nullif(lower(trim(v_cust.country)), ''), 'india') not in ('india','in','ind','bharat');
  v_rate := case
              when v_export then 0
              when public.supplier_gst_status(v_txn.tenant_id, public.ist_today()) in ('unregistered', 'composition') then 0
              else 18
            end;

  /* The builder's line shape: id, item_id, name, qty, rate (₹ per unit for the term), cost,
     commitment — a one-time line carries one_time: true and no commitment (R-1688). */
  select jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object(
             'id',         coalesce(nullif(li->>'id', ''), 'line-' || ord),
             'item_id',    nullif(li->>'item_id', ''),
             'name',       btrim(li->>'name'),
             'qty',        (li->>'qty')::int,
             'rate',       (li->>'rate')::int,
             'cost',       coalesce(case when coalesce(li->>'cost', '') ~ '^[0-9]+$' then (li->>'cost')::int end, 0),
             'commitment', case when li->>'commitment' in ('annual_yearly', 'monthly') then li->>'commitment' end,
             'one_time',   case when coalesce(li->>'commitment', 'one_time') = 'one_time' then true end))
           order by ord)
    into v_lines
    from jsonb_array_elements(p_lines) with ordinality as t(li, ord);

  select coalesce(sum((li->>'qty')::int * (li->>'rate')::int), 0) into v_subtotal
    from jsonb_array_elements(v_lines) li;
  if v_subtotal <= 0 then raise exception 'The sale total must be more than ₹0.' using errcode = '22023'; end if;
  v_gross := v_subtotal + round(v_subtotal * v_rate / 100.0)::int;
  select sum((li->>'qty')::int) into v_seats from jsonb_array_elements(v_lines) li where li ? 'commitment';

  v_qid := public.next_document_number('quote', v_txn.tenant_id, public.ist_today());
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, is_one_off, billing_cycle, created_date, notes
  ) values (
    v_qid, v_txn.tenant_id, p_customer_id, v_cust.name, v_lines->0->>'name', v_seats,
    v_gross, v_subtotal, v_rate, 0,
    v_lines, 'accepted', 'awaiting', not (v_monthly or v_annual), v_cycle,
    public.ist_today(), 'Sale booked from a bank receipt of ' || to_char(v_txn.txn_date, 'DD Mon YYYY')
  );

  return jsonb_build_object('quote_id', v_qid, 'quote_total', v_gross, 'tax_rate', v_rate);
end;
$$;
revoke all on function public.bank_credit_new_sale_quote(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.bank_credit_new_sale_quote(uuid, uuid, jsonb, text) to service_role;

create or replace function public.reconcile_bank_credit_new_sale(
  p_txn_id              uuid,
  p_customer_id         uuid,
  p_lines               jsonb,
  p_create_subscription boolean default true,
  p_sub_start           date    default null,
  p_sub_renewal         date    default null,
  p_tds_amount          integer default 0,
  p_tds_rate_pct        numeric default null,
  p_tds_section         text    default null,
  p_billing_cycle       text    default null   -- R-2026: yearly | half_yearly | quarterly | monthly
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid;
  v_trusted  boolean;
  v_txn      record;
  v_sale     jsonb;
begin
  /* R-2098: the quote is bank_credit_new_sale_quote (shared with the split); guards unchanged. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;

  select t.id, t.tenant_id into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;

  v_sale := public.bank_credit_new_sale_quote(p_txn_id, p_customer_id, p_lines, p_billing_cycle);

  return public.reconcile_bank_credit_to_item(
           p_txn_id, v_sale->>'quote_id', null, p_tds_amount, p_tds_rate_pct, p_tds_section,
           p_create_subscription, p_sub_start, p_sub_renewal)
         || jsonb_build_object('new_quote', true, 'quote_total', (v_sale->>'quote_total')::int, 'tax_rate', (v_sale->>'tax_rate')::int);
end;
$$;
revoke all on function public.reconcile_bank_credit_new_sale(uuid, uuid, jsonb, boolean, date, date, integer, numeric, text, text) from public, anon;
grant execute on function public.reconcile_bank_credit_new_sale(uuid, uuid, jsonb, boolean, date, date, integer, numeric, text, text) to authenticated, service_role;

-- ── 6. reconcile_bank_credit_split — one line, several items, ONE transaction ────────────────
create or replace function public.reconcile_bank_credit_split(
  p_txn_id      uuid,
  p_customer_id uuid,
  p_items       jsonb,              -- [{quote_id | invoice_id, amount}]
  p_sale        jsonb default null, -- {lines, billing_cycle, create_subscription, sub_start, sub_renewal, amount}
  p_rest        text  default null  -- what the difference is: 'advance' | 'round_off' (null = must be exact)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2098. The round-off limit (₹50) is ROUND_OFF_LIMIT in src/lib/banking/credit-pay-for-split.ts. */
declare
  c_limit     constant integer := 50;
  v_caller    uuid;
  v_trusted   boolean;
  v_txn       record;
  v_ref       text;
  v_item      jsonb;
  v_amt       numeric;
  v_due       integer;
  v_open      record;
  v_keys      text[] := array[]::text[];
  v_quotes    text[] := array[]::text[];
  v_key       text;
  v_sum       integer := 0;
  v_sale_amt  integer := 0;
  v_sale      jsonb;
  v_diff      integer;
  v_core      jsonb;
  v_parts     jsonb := '[]'::jsonb;
  v_pay_ids   uuid[] := array[]::uuid[];
  v_first     uuid;
  v_adv       jsonb := null;
  v_round     integer := 0;
  v_n         integer := 0;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;

  /* The line, locked: a second click waits here, then finds it reconciled and is refused. */
  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can pay quotes or invoices.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.tenant_id = v_txn.tenant_id) then
    raise exception 'Customer not found in your company — pick the customer who paid.' using errcode = 'no_data_found';
  end if;
  if p_rest is not null and p_rest not in ('advance', 'round_off') then
    raise exception 'The money left over is either an advance or a round-off.' using errcode = '22023';
  end if;
  if p_items is null then p_items := '[]'::jsonb; end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Pick the quotes / invoices this money pays.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) = 0 and p_sale is null then
    raise exception 'Pick at least one quote / invoice or a new sale this money pays.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'Too many items on one bank line (% — at most 100).', jsonb_array_length(p_items) using errcode = '22023';
  end if;

  /* Each item: one of this customer's OPEN items (bank_credit_open_items — the list the sheet
     shows), listed once, a whole-rupee amount no more than its due. */
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or (nullif(v_item->>'quote_id', '') is null) = (nullif(v_item->>'invoice_id', '') is null) then
      raise exception 'Each item is one quote or one invoice. Refresh and try again.' using errcode = '22023';
    end if;
    begin
      v_amt := (v_item->>'amount')::numeric;
    exception when others then
      raise exception 'The amount for % is not a number.', coalesce(v_item->>'invoice_id', v_item->>'quote_id') using errcode = '22023';
    end;
    if v_amt is null or v_amt <= 0 or v_amt <> trunc(v_amt) then
      raise exception 'Enter a whole-rupee amount of more than ₹0 for %.', coalesce(v_item->>'invoice_id', v_item->>'quote_id') using errcode = '22023';
    end if;
    v_key := coalesce('I:' || nullif(v_item->>'invoice_id', ''), 'Q:' || (v_item->>'quote_id'));
    if v_key = any(v_keys) then
      raise exception '% is listed twice. Keep it once with the full amount.', coalesce(v_item->>'invoice_id', v_item->>'quote_id') using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;
    select o.* into v_open from public.bank_credit_open_items(p_customer_id) o
     where (nullif(v_item->>'invoice_id', '') is not null and o.invoice_id = v_item->>'invoice_id')
        or (nullif(v_item->>'invoice_id', '') is null and o.invoice_id is null and o.quote_id = v_item->>'quote_id');
    if not found then
      raise exception '% is not an open quote or invoice of this customer. Refresh and try again.', coalesce(v_item->>'invoice_id', v_item->>'quote_id')
        using errcode = 'check_violation';
    end if;
    if v_amt > v_open.amount_due then
      raise exception '₹% on % is more than its ₹% due. Put the extra on another item or keep it as advance.',
        v_amt::int, coalesce(v_item->>'invoice_id', v_item->>'quote_id'), v_open.amount_due using errcode = 'check_violation';
    end if;
    /* record_payment replays on quote + reference: two items of one quote would book one. */
    if v_open.quote_id is not null then
      if v_open.quote_id = any(v_quotes) then
        raise exception 'Two of these items belong to quote %. Pay one of them here and the other on its own.', v_open.quote_id
          using errcode = 'check_violation';
      end if;
      v_quotes := v_quotes || v_open.quote_id;
    end if;
    v_sum := v_sum + v_amt::int;
  end loop;

  if p_sale is not null then
    begin
      v_sale_amt := (p_sale->>'amount')::int;
    exception when others then
      raise exception 'The amount for the new sale is not a whole number.' using errcode = '22023';
    end;
    if coalesce(v_sale_amt, 0) <= 0 then
      raise exception 'Enter how much of this money pays the new sale (more than ₹0).' using errcode = '22023';
    end if;
    v_sum := v_sum + v_sale_amt;
  end if;

  /* Allocated vs received. */
  v_diff := v_txn.credit - v_sum;
  if v_diff < 0 then
    if p_rest = 'round_off' and -v_diff <= c_limit then
      v_round := -v_diff;          -- settled more than came in: a charge
    else
      raise exception 'The items add up to ₹% but only ₹% came in. Lower an amount (a difference up to ₹% can be written off as round-off).',
        v_sum, v_txn.credit, c_limit using errcode = 'check_violation';
    end if;
  elsif v_diff > 0 then
    if p_rest = 'advance' then
      null;
    elsif p_rest = 'round_off' and v_diff <= c_limit then
      v_round := -v_diff;          -- a little more came in: a gain
    else
      raise exception '₹% of the ₹% received is not on any item. Keep it as the customer''s advance%.',
        v_diff, v_txn.credit, case when v_diff <= c_limit then ' or write it off as round-off' else '' end
        using errcode = 'check_violation';
    end if;
  end if;

  /* R-1676: one UTR on several receipts — only this call's own, and not already used. */
  v_ref := coalesce(nullif(btrim(v_txn.reference), ''), 'BANK-' || v_txn.id::text);
  perform public.assert_payment_ref_unused(v_txn.tenant_id, 'bank_transfer', v_ref);
  perform set_config('app.payment_ref_batch', coalesce(public.payment_ref_key('bank_transfer', v_ref), ''), true);

  /* Each item as if paid on its own. */
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_core := public.bank_credit_pay_item(
      p_txn_id, (v_item->>'amount')::numeric::int, v_ref,
      case when nullif(v_item->>'invoice_id', '') is null then v_item->>'quote_id' end,
      nullif(v_item->>'invoice_id', ''), 0, null, null, null, null, null);
    if coalesce((v_core->>'replay')::boolean, false) then
      raise exception '% already has a payment with reference %. Nothing was saved.', coalesce(v_item->>'invoice_id', v_item->>'quote_id'), v_ref
        using errcode = 'unique_violation';
    end if;
    v_pay_ids := v_pay_ids || (v_core->>'payment_id')::uuid;
    v_parts := v_parts || public.bank_credit_item_result(v_txn.tenant_id, v_core, nullif(v_item->>'invoice_id', ''),
                                                          (v_item->>'amount')::numeric::int, 0);
  end loop;

  if p_sale is not null then
    v_sale := public.bank_credit_new_sale_quote(p_txn_id, p_customer_id, p_sale->'lines', nullif(p_sale->>'billing_cycle', ''));
    if v_sale_amt > (v_sale->>'quote_total')::int then
      raise exception '₹% on the new sale is more than its ₹% total. Put the extra on another item or keep it as advance.',
        v_sale_amt, (v_sale->>'quote_total')::int using errcode = 'check_violation';
    end if;
    v_core := public.bank_credit_pay_item(
      p_txn_id, v_sale_amt, v_ref, v_sale->>'quote_id', null, 0, null, null,
      case when p_sale ? 'create_subscription' then (p_sale->>'create_subscription')::boolean end,
      nullif(p_sale->>'sub_start', '')::date, nullif(p_sale->>'sub_renewal', '')::date);
    v_pay_ids := v_pay_ids || (v_core->>'payment_id')::uuid;
    v_parts := v_parts || (public.bank_credit_item_result(v_txn.tenant_id, v_core, null, v_sale_amt, 0)
                           || jsonb_build_object('new_quote', true, 'quote_total', (v_sale->>'quote_total')::int,
                                                 'tax_rate', (v_sale->>'tax_rate')::int));
  end if;

  if p_rest = 'advance' and v_diff > 0 then
    v_adv := public.bank_credit_book_advance(p_txn_id, p_customer_id, v_diff);
    v_pay_ids := v_pay_ids || (v_adv->>'payment_id')::uuid;
  end if;
  perform set_config('app.payment_ref_batch', '', true);

  /* The line → its first receipt (every existing reader); all receipts → the line. Reconcile
     FIRST: trg_bank_split_line_unmatched clears bank_txn_id when the match changes. */
  v_first := v_pay_ids[1];
  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_first::text, 'manual');
  update public.payments set bank_txn_id = p_txn_id
   where tenant_id = v_txn.tenant_id and id = any(v_pay_ids);
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_pay_ids) then
    raise exception 'R-2098: linked % of % receipts to the bank line — nothing was saved.', v_n, cardinality(v_pay_ids);
  end if;
  if v_round <> 0 then
    insert into public.bank_receipt_round_offs (tenant_id, bank_txn_id, amount, created_by)
    values (v_txn.tenant_id, p_txn_id, v_round, auth.uid());
  end if;

  return jsonb_build_object(
    'kind',           'split',
    'amount',         v_txn.credit,
    'allocated',      v_sum,
    'parts',          v_parts,
    'advance_credit', case when v_adv is not null then v_diff else 0 end,
    'advance_quote_id', v_adv->>'quote_id',
    'advance_receipt_voucher_no', v_adv->>'receipt_voucher_no',
    'round_off',      v_round,
    'payment_id',     v_first);
end;
$$;
revoke all on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text) to authenticated, service_role;
comment on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text) is
  'R-2098: one money-in bank line → several of one customer''s open quotes / invoices (+ an optional new sale), each paid through bank_credit_pay_item (record_desk_payment / record_instalment_payment) as if paid alone; the rest → advance (R-1863) or a round-off (≤ ₹50, bank_receipt_round_offs). One transaction; the line is matched to the first receipt and every receipt carries payments.bank_txn_id. Owner/manager/accountant/billing; tenant fail-closed.';

-- ── 7. report_settlement_shortfalls — the round-off is the line's settlement difference ─────
create or replace function public.report_settlement_shortfalls(p_from date, p_to date)
returns table (txn_date date, amount bigint, payment_id uuid, reference text)
language sql
stable
security invoker
set search_path = public
as $function$
  -- Payment ke aane wale paise = amount − customer ka TDS − book hui gateway fee. Us payment
  -- se match hui bank lines ka credit usse kam ho to farq bank / gateway ne rakha.
  -- Zyada aaya ho to yahan kuch nahi (wo galat match hai, kharcha nahi).
  -- R-2098: ek line par kai receipts (payments.bank_txn_id) — un par per-payment hisaab nahi;
  -- us line ka farq wahi hai jo owner ne round-off likha (bank_receipt_round_offs, − = gain).
  with m as (
    select p.id, p.reference,
           -- R-1565: advance credit applied never reaches the bank — it is not a shortfall.
           (p.amount - p.credit_applied)::bigint
             - coalesce((select sum(t.tds_amount) from public.tds_receivable t
                          where t.tenant_id = p.tenant_id and t.payment_id = p.id), 0)
             - coalesce((select e.amount from public.expenses e
                          where e.tenant_id = p.tenant_id and e.id = 'EXP-RZPFEE-' || p.id::text), 0) as expected,
           sum(b.credit)::bigint as credited,
           max(b.txn_date) as txn_date
      from public.payments p
      join public.bank_transactions b
        on b.tenant_id = p.tenant_id and b.matched_to_type = 'payment' and b.matched_to_id = p.id::text
     where p.tenant_id = public.current_tenant_id() and p.status = 'received'
       and p.bank_txn_id is null
     group by p.id, p.reference, p.amount, p.credit_applied, p.tenant_id
  )
  select m.txn_date, (m.expected - m.credited)::bigint, m.id, m.reference
    from m
   where m.expected > m.credited and m.txn_date between p_from and p_to
  union all
  select b.txn_date, r.amount::bigint, null::uuid, b.reference
    from public.bank_receipt_round_offs r
    join public.bank_transactions b on b.id = r.bank_txn_id and b.tenant_id = r.tenant_id
   where r.tenant_id = public.current_tenant_id()
     and b.matched_to_type is not null
     and b.txn_date between p_from and p_to;
$function$;
revoke all on function public.report_settlement_shortfalls(date, date) from public, anon;
grant execute on function public.report_settlement_shortfalls(date, date) to authenticated, service_role;

-- ── 8. report_balance_sheet — R-1992 body; a receipt on a split line is banked ──────────────
CREATE OR REPLACE FUNCTION public.report_balance_sheet(p_as_of date DEFAULT NULL::date)
 RETURNS TABLE(as_of date, fy_start_year integer, fy_label text, cash_and_bank bigint, undeposited_funds bigint, credit_card_payable bigint, receivables bigint, advances_from_customers bigint, project_receivable bigint, tds_receivable bigint, employee_loans bigint, prepaid_advances bigint, emi_unregistered_cost bigint, emi_loans_payable bigint, business_loans_payable bigint, payables bigint, salary_payable bigint, dues_salary_tds bigint, dues_pf bigint, dues_esi bigint, dues_vendor_tds bigint, dues_paid jsonb, reimbursements_payable bigint, gst_output bigint, bills_gst bigint, itc_groups jsonb, fixed_assets jsonb, tax_payments jsonb, expenses_payable bigint, expenses_paid_unbanked bigint, salary_other_deductions bigint, bill_itc_groups jsonb, commissions_payable bigint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  -- R-1580: commission TDS in dues_vendor_tds; commissions_payable.
  -- R-1739: gst_output skips imported Zoho opening invoices (receivables keep them).
  -- R-1849: partner TDS in dues_vendor_tds.
  -- R-1913: expenses_payable / expenses_paid_unbanked less the advance applied to the bill (the advance left the prepaid asset when applied).
  -- R-1915: and less the cash its bank parts paid (expenses.paid_amount — that money is in the bank balance).
  -- R-1952: as of the report date — only advance applications dated on or before it
  --   (vendor_advance_applications.applied_on) and bank parts whose bank line is dated on or before it
  --   come off the bill; a bill settled by its advance / last bank part AFTER that date is still payable
  --   then, and an advance applied after it is still prepaid.
  -- R-1992: project TDS (project_payments method 'tds') is not undeposited cash — it is in
  --   tds_receivable; project money received beyond the invoiced milestones is an advance
  --   from the customer (liability), the mirror of project_receivable.
  v_tenant  uuid := public.current_tenant_id();
  v_to      date := coalesce(p_as_of, (now() at time zone 'Asia/Kolkata')::date);
  v_fy_year int;
  v_cash    bigint;
  v_card    bigint;
  v_own_state text;
begin
  if v_tenant is null then
    raise exception 'Balance sheet nahi ban sakti: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Indian FY: April se pehle ke mahine pichhle saal ke FY me.
  v_fy_year := case when extract(month from v_to) < 4 then extract(year from v_to)::int - 1
                    else extract(year from v_to)::int end;

  -- Cash & bank: har account = opening + sum(credit − debit), ek hi pass me (N+1 khatam).
  -- Credit card liability hai: negative = card par bakaya; positive (overpaid) = cash.
  select coalesce(sum(case when b.account_type = 'credit_card' and b.bal < 0 then 0 else b.bal end), 0),
         coalesce(sum(case when b.account_type = 'credit_card' and b.bal < 0 then -b.bal else 0 end), 0)
    into v_cash, v_card
    from (
      select a.account_type,
             a.opening_balance::bigint + coalesce((
               select sum(t.credit - t.debit)
                 from public.bank_transactions t
                where t.bank_account_id = a.id and t.tenant_id = v_tenant), 0) as bal
        from public.bank_accounts a
       where a.tenant_id = v_tenant
    ) b;

  -- R-1576: hamara rajya (state check ke liye) — report.ts jaisa: state_code, warna GSTIN ke pehle 2.
  select coalesce(nullif(trim(t.state_code), ''), nullif(left(trim(coalesce(t.gstin, '')), 2), ''))
    into v_own_state from public.tenants t where t.id = v_tenant;

  return query
  select
    v_to,
    v_fy_year,
    'FY ' || v_fy_year || '-' || lpad(((v_fy_year + 1) % 100)::text, 2, '0'),
    v_cash,
    -- R-179: receipts jo kisi bank line se match nahi hue — paisa haath me, asset.
    -- S45-TB: payment.amount me customer ka kaata hua TDS bhi hai (record_payment_with_tds
    -- invoice ko gross se settle karta hai). Wo TDS paisa kabhi aaya hi nahi — tds_receivable
    -- me asset hai. Yahan bhi gina to ek hi ₹ do baar Dr. Isliye us payment ka TDS ghatao.
    -- R-1612: amount − credit_applied — advance credit inside a payment was money in on the
    -- payment that created it (R-1565), not again here.
    ((select coalesce(sum(p.amount - p.credit_applied - coalesce((select sum(t.tds_amount) from public.tds_receivable t
                                                where t.tenant_id = v_tenant and t.payment_id = p.id), 0)
                                  -- S45-SLICE2: Razorpay fee book ho chuki (EXP-RZPFEE-<id>, R-045) to wo
                                  -- paisa kabhi bank me nahi aayega — fee P&L me hai, yahan bhi gini to do baar.
                                  - coalesce((select e.amount from public.expenses e
                                               where e.tenant_id = v_tenant and e.id = 'EXP-RZPFEE-' || p.id::text), 0)), 0)
        from public.payments p
       where p.tenant_id = v_tenant and p.status = 'received'
         and not exists (select 1 from public.bank_transactions t
                          where t.tenant_id = v_tenant and t.matched_to_type = 'payment'
                            and t.matched_to_id = p.id::text)
         -- R-2098: one bank line carrying several receipts (payments.bank_txn_id) — each is banked.
         and not (p.bank_txn_id is not null
                  and exists (select 1 from public.bank_transactions t2
                               where t2.tenant_id = v_tenant and t2.id = p.bank_txn_id
                                 and t2.matched_to_type is not null)))
   + (select coalesce(sum(pp.amount), 0)
        from public.project_payments pp
       where pp.tenant_id = v_tenant and pp.bank_txn_id is null
         -- R-1992: the TDS part (record_project_receipt_with_tds) never came in as cash — it is
         -- in tds_receivable already; counting it here made the same ₹ an asset twice.
         and coalesce(pp.method, '') <> 'tds'))::bigint,
    v_card,
    -- Trade receivables (accrual): pending/overdue, project-milestone invoices CHHOD kar
    -- (wo project_receivable me hain — dono me gine to double count).
    -- S45-TB: net_payable − paid_amount. record_payment har part payment par paid_amount
    -- likhta hai (R-015) aur Aging bhi yahi padhta hai; poora net_payable ginne se ₹40,000
    -- ka part payment cash me bhi aur receivable me bhi — TB me utna farq.
    (select coalesce(sum(greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))), 0)::bigint
       from public.invoices i
      where i.tenant_id = v_tenant
        and i.status in ('pending', 'overdue')
        and not exists (select 1 from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.invoice_id = i.id)),
    -- Customer advances: received payments jinke quote par abhi invoice nahi — liability.
    -- S45-TB: + invoice ke BAAD customer ka bakaaya paisa (overpayment, ya paid invoice par
    -- credit note): quote par mila − (invoice − credit notes + debit notes), jab > 0. Pehle
    -- ye kahin nahi tha — paisa cash me, deni-daari kahin nahi. Sirf quote ka apna ek hi
    -- invoice (split billing ke kai invoice wale quote chhode — wahan ye hisaab nahi banta).
    -- R-1612: (1) − the overpayment credit those payments opened (open credit is in (3); used
    -- credit sits in the payment that used it) − what is applied to the quote's raised
    -- instalment invoices (split billing: no invoice of its own, R-1564); (2) − the same
    -- credit; (3) + the customer's open (unused) credit.
    ((select coalesce(sum(greatest(0,
               (select coalesce(sum(p.amount), 0) from public.payments p
                 where p.tenant_id = v_tenant and p.quote_id = q.id and p.status = 'received')
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                 join public.payments p on p.id = cc.source_payment_id and p.tenant_id = v_tenant
                where cc.tenant_id = v_tenant and cc.source in ('overpayment', 'redeemed_split')  -- R-1614: + the used part of a split
                  and p.quote_id = q.id and p.status = 'received')
             - (select coalesce(sum(i.paid_amount), 0)
                  from public.subscriptions s
                  join public.subscription_billings b on b.subscription_id = s.id and b.tenant_id = v_tenant
                  join public.invoices i on i.id = b.invoice_id and i.tenant_id = v_tenant
                 where s.tenant_id = v_tenant and s.quote_id = q.id
                   and i.status in ('pending', 'paid', 'overdue')))), 0)
        from public.quotes q
       where q.tenant_id = v_tenant and q.invoice_id is null)
   + (select coalesce(sum(greatest(0,
               (select coalesce(sum(p.amount), 0) from public.payments p
                 where p.tenant_id = v_tenant and p.quote_id = q.id and p.status = 'received')
             - (i.amount
                - coalesce((select sum(c.amount) from public.credit_notes c
                             where c.tenant_id = v_tenant and c.invoice_id = i.id), 0)
                + coalesce((select sum(d.amount) from public.debit_notes d
                             where d.tenant_id = v_tenant and d.invoice_id = i.id), 0))
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                 join public.payments p on p.id = cc.source_payment_id and p.tenant_id = v_tenant
                where cc.tenant_id = v_tenant and cc.source in ('overpayment', 'redeemed_split')  -- R-1614: + the used part of a split
                  and p.quote_id = q.id and p.status = 'received')
             /* R-1563: the excess a credit note left on this invoice now sits in a
                customer_credits row (source_invoice_id) — open: counted in (3); used: inside the
                payment that used it; refunded: paid out with its payment. Not here again. */
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                where cc.tenant_id = v_tenant and cc.source_invoice_id = i.id
                  and cc.status in ('open', 'used')))), 0)
        from public.quotes q
        join public.invoices i on i.id = q.invoice_id and i.tenant_id = v_tenant
       where q.tenant_id = v_tenant
         and i.status in ('pending', 'paid', 'overdue')
         and not exists (select 1 from public.invoices i2
                          where i2.tenant_id = v_tenant and i2.quote_id = q.id and i2.id <> i.id)
         and not exists (select 1 from public.project_milestones pm
                          where pm.tenant_id = v_tenant and pm.invoice_id = i.id))
   + (select coalesce(sum(cc.amount), 0)
        from public.customer_credits cc
       where cc.tenant_id = v_tenant and cc.status = 'open')
    -- R-1992: (4) project money received beyond the invoiced milestones (an advance before the
    -- invoice, or more than invoiced) — the mirror of project_receivable below, same projects,
    -- so per project receivable − advance = invoiced − received.
   + (select coalesce(sum(greatest(0,
              coalesce((select sum(pp.amount) from public.project_payments pp
                         where pp.tenant_id = v_tenant and pp.project_id = ps.id), 0)
            - coalesce((select sum(pm.total_amount) from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.project_id = ps.id and pm.invoice_id is not null), 0))), 0)
        from public.project_sales ps
       where ps.tenant_id = v_tenant and ps.status in ('active', 'completed')))::bigint,
    -- Project receivable: har active/completed project ka max(0, invoiced milestones − received).
    (select coalesce(sum(greatest(0,
              coalesce((select sum(pm.total_amount) from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.project_id = ps.id and pm.invoice_id is not null), 0)
            - coalesce((select sum(pp.amount) from public.project_payments pp
                         where pp.tenant_id = v_tenant and pp.project_id = ps.id), 0))), 0)::bigint
       from public.project_sales ps
      where ps.tenant_id = v_tenant and ps.status in ('active', 'completed')),
    (select coalesce(sum(t.tds_amount), 0)::bigint
       from public.tds_receivable t
      where t.tenant_id = v_tenant and t.status in ('pending_cert', 'cert_received', 'verified_26as')),
    -- Employee loans: KUL principal − KUL repayments (per-loan max(0) nahi — purana TS bhi
    -- total par karta tha; parity ke liye waise hi).
    greatest(0,
      (select coalesce(sum(l.principal), 0) from public.employee_loans l where l.tenant_id = v_tenant)
    - (select coalesce(sum(r.amount), 0) from public.employee_loan_repayments r where r.tenant_id = v_tenant))::bigint,
    ((select coalesce(sum(greatest(0, pa.total_amount - pa.consumed_amount)), 0)
        from public.prepaid_advances pa where pa.tenant_id = v_tenant)
     -- R-1952: an advance applied to a bill after the report date was still an advance then.
   + (select coalesce(sum(a.amount), 0)
        from public.vendor_advance_applications a where a.tenant_id = v_tenant and a.applied_on > v_to))::bigint,
    -- EMI purchase jo abhi fixed-asset register me nahi — cost par (register wale WDV par, TS me).
    (select coalesce(sum(ep.total_cost), 0)::bigint
       from public.emi_purchases ep
      where ep.tenant_id = v_tenant
        and not exists (select 1 from public.fixed_assets fa
                         where fa.tenant_id = v_tenant and fa.emi_purchase_id = ep.id)),
    greatest(0,
      (select coalesce(sum(ep.financed), 0) from public.emi_purchases ep where ep.tenant_id = v_tenant)
    - (select coalesce(sum(em.principal_part), 0) from public.emi_payments em where em.tenant_id = v_tenant))::bigint,
    greatest(0,
      (select coalesce(sum(bl.principal), 0) from public.business_loans bl where bl.tenant_id = v_tenant)
    - (select coalesce(sum(bp.principal_part), 0) from public.business_loan_payments bp where bp.tenant_id = v_tenant))::bigint,
    (select coalesce(sum(greatest(0, vb.total - vb.paid_amount)), 0)::bigint
       from public.vendor_bills vb where vb.tenant_id = v_tenant and vb.status <> 'paid'),
    (select coalesce(sum(greatest(0, s.net - s.paid_amount)), 0)::bigint
       from public.salary_payments s where s.tenant_id = v_tenant and s.paid_status <> 'paid'),
    -- Statutory dues ke hisse (har booked salary, paid ho ya nahi; employer share bhi) —
    -- statutoryDues() TS me jodta hai, taaki Payroll banner aur ye ek hi niyam rahein.
    (select coalesce(sum(s.tds), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    (select coalesce(sum(s.pf + s.pf_employer), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    (select coalesce(sum(s.esi + s.esi_employer), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    -- R-1580: + TDS kaata partner commission par (194H) — credit (earned) hote hi sarkar ka
    -- dena, commission paid ho ya nahi; cancelled me kuch kaata nahi. Challan dues_paid me.
    ((select coalesce(sum(e.tds_amount), 0) from public.expenses e where e.tenant_id = v_tenant and e.tds_amount > 0)
   + (select coalesce(sum(rc.tds_amount), 0) from public.referral_commissions rc
       where rc.tenant_id = v_tenant and rc.tds_amount > 0 and rc.status <> 'cancelled')
    -- R-1891: 194Q TDS deducted when a COGS bill was paid from the bank.
   + (select coalesce(sum(l.tds_amount), 0) from public.bank_vendor_payment_lines l
       where l.tenant_id = v_tenant and l.kind in ('bill', 'new_bill') and l.tds_amount > 0)
    -- R-1849: TDS on partners' interest + remuneration (194T / 393(3)), owed from the year-end credit.
   + (select coalesce(sum(pl.tds), 0) from public.partner_appropriation_lines pl
       where pl.tenant_id = v_tenant and pl.tds > 0))::bigint,
    (select coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'amount', d.amount) order by d.kind), '[]'::jsonb)
       from (select sd.kind, sum(sd.amount)::bigint as amount
               from public.statutory_dues_payments sd where sd.tenant_id = v_tenant group by sd.kind) d),
    (select coalesce(sum(r.amount), 0)::bigint
       from public.reimbursements r where r.tenant_id = v_tenant and r.status = 'pending'),
    -- GST CUMULATIVE (≤ as_of): frozen tax_amount, purani row me amount se reverse-derive
    -- (rate ?? 18), phir credit note ghatao, debit note jodo.
    ((select coalesce(sum(coalesce(i.tax_amount,
               floor(i.amount::numeric * coalesce(i.tax_rate, 18) / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint)), 0)
        from public.invoices i
       where i.tenant_id = v_tenant and i.invoice_date <= v_to and i.status in ('pending', 'paid', 'overdue')
         and public.invoice_is_sale(i.document_kind))  -- R-1739: no GST on an imported Zoho opening invoice
     - (select coalesce(sum(c.tax_amount), 0) from public.credit_notes c where c.tenant_id = v_tenant and c.credit_date <= v_to)
     + (select coalesce(sum(d.tax_amount), 0) from public.debit_notes d where d.tenant_id = v_tenant and d.debit_date <= v_to))::bigint,
    (select coalesce(sum(vb.cgst + vb.sgst + vb.igst), 0)::bigint
       from public.vendor_bills vb where vb.tenant_id = v_tenant and vb.bill_date <= v_to),
    -- ITC: expense GST ko (bill_type, category, vendor GSTIN) par group karke — eligibility
    -- splitItc() TS me hi tay karta hai. Sirf gst_paid > 0 rows (splitItc 0 ko chhod deta hai).
    (select coalesce(jsonb_agg(jsonb_build_object('bill_type', g.bill_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'gst_paid', g.gst, 'n', g.n)), '[]'::jsonb)
       from (select e.bill_type, e.category, v.gstin, sum(e.gst_paid)::bigint as gst, count(*)::int as n
               from public.expenses e
               left join public.vendors v on v.id = e.vendor_id and v.tenant_id = v_tenant
              where e.tenant_id = v_tenant and e.expense_date <= v_to and e.gst_paid > 0
              group by e.bill_type, e.category, v.gstin) g),
    -- Fixed-asset register (chhoti table) — WDV bookValueNow() TS me.
    (select coalesce(jsonb_agg(jsonb_build_object('id', fa.id, 'name', fa.name, 'block', fa.block, 'cost', fa.cost,
                                                  'put_to_use', fa.put_to_use, 'disposed_on', fa.disposed_on,
                                                  'disposal_value', fa.disposal_value, 'emi_purchase_id', fa.emi_purchase_id)
                               order by fa.put_to_use, fa.id), '[]'::jsonb)
       from public.fixed_assets fa where fa.tenant_id = v_tenant),
    -- Tax challans (GST + income tax) — kind/period/fy par jode hue.
    (select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'amount', t.amount, 'period', t.period, 'fy', t.fy)), '[]'::jsonb)
       from (select tp.kind, tp.period, tp.fy, sum(tp.amount)::bigint as amount
               from public.tax_payments tp where tp.tenant_id = v_tenant group by tp.kind, tp.period, tp.fy) t),
    -- S45-SLICE2 (G4): unpaid expenses — P&L me kharcha, ab tak koi payable nahi tha.
    -- amount − TDS (TDS dues_vendor_tds me pehle se). Bank line se match = paid, bahar.
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0)
                          - (coalesce(e.advance_applied, 0) - x.adv_after)
                          - (coalesce(e.paid_amount, 0) - x.parts_after)), 0)::bigint
       from public.expenses e
       -- R-1952: what came off the bill AFTER the report date (advance applied, bank parts).
       cross join lateral (
         select coalesce((select sum(a.amount) from public.vendor_advance_applications a
                           where a.tenant_id = v_tenant and a.expense_id = e.id and a.applied_on > v_to), 0) as adv_after,
                coalesce((select sum(l.cash) from public.bank_vendor_payment_lines l
                            join public.bank_transactions t on t.id = l.bank_txn_id
                           where l.tenant_id = v_tenant and l.expense_id = e.id and l.kind = 'expense'
                             and t.txn_date > v_to), 0) as parts_after) x
      where e.tenant_id = v_tenant
        and ((e.paid = false and e.reconciled_txn_id is null
              and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance'))
             -- R-1952: settled from the vendor's advance after the report date → still owed then.
             or (e.paid and e.reconciled_txn_id is null and e.payment_method = 'advance' and x.adv_after > 0)
             -- R-1952: its last bank part came after the report date → still owed then.
             or (e.paid and e.reconciled_txn_id is not null and x.parts_after > 0
                 and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')))
        and e.expense_date <= v_to
        and e.prepaid_advance_id is null and e.id not like 'EXP-RZPFEE-%'
        and not public.report_expense_has_own_credit(v_tenant, e.id)),
    -- S45-SLICE2 (G2): "paid" expenses jinki koi bank line match nahi — cash / UPI jo bank
    -- me abhi dikha nahi. Paisa haath se gaya; undeposited funds ka aaina (cash ka ulta).
    -- Jinka Cr pehle se kahin hai wo bahar: payroll/statutory (salary payable + dues),
    -- reimbursement (reimbursements payable), emi (loan + apni bank line), advance
    -- (employee loan / prepaid), EXP-RZPFEE-* (undeposited se ghata).
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0)
                          - (coalesce(e.advance_applied, 0) - x.adv_after)
                          - (coalesce(e.paid_amount, 0) - x.parts_after)), 0)::bigint
       from public.expenses e
       -- R-1952: what came off the bill AFTER the report date (advance applied, bank parts).
       cross join lateral (
         select coalesce((select sum(a.amount) from public.vendor_advance_applications a
                           where a.tenant_id = v_tenant and a.expense_id = e.id and a.applied_on > v_to), 0) as adv_after,
                coalesce((select sum(l.cash) from public.bank_vendor_payment_lines l
                            join public.bank_transactions t on t.id = l.bank_txn_id
                           where l.tenant_id = v_tenant and l.expense_id = e.id and l.kind = 'expense'
                             and t.txn_date > v_to), 0) as parts_after) x
      where e.tenant_id = v_tenant and e.paid is distinct from false and e.reconciled_txn_id is null
        and e.expense_date <= v_to
        and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
        and e.prepaid_advance_id is null and e.id not like 'EXP-RZPFEE-%'
        and not public.report_expense_has_own_credit(v_tenant, e.id)),
    -- S45-SLICE2 (G3): salary se kaata "other" deduction — kharcha gross hai, net payable
    -- kam; ye raqam company ke paas rakhi hai (kisi ko dena / wapas). Pehle kahin nahi.
    (select coalesce(sum(s.other_deduction), 0)::bigint
       from public.salary_payments s where s.tenant_id = v_tenant),
    -- R-1576: bills ka GST bhi ITC niyam se (lib/gst/bill-itc.ts) — document_type, vendor GSTIN,
    -- heads (state check ke liye IGST / CGST+SGST alag group), category (s.17(5)). TS tay karta hai.
    (select coalesce(jsonb_agg(jsonb_build_object('document_type', g.document_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'cgst', g.cgst, 'sgst', g.sgst, 'igst', g.igst,
                                                  'n', g.n, 'ownStateCode', v_own_state)), '[]'::jsonb)
       from (select b.document_type, b.category, b.vendor_gstin as gstin,
                    sum(b.cgst)::bigint as cgst, sum(b.sgst)::bigint as sgst, sum(b.igst)::bigint as igst, count(*)::int as n
               from public.vendor_bills b
              where b.tenant_id = v_tenant and b.bill_date <= v_to and b.cgst + b.sgst + b.igst > 0
              group by b.document_type, b.category, b.vendor_gstin, (b.igst > 0), (b.cgst + b.sgst > 0)) g),
    -- R-1580: partner commission earned par abhi diya nahi — P&L me gross kharcha, yahan net
    -- deni-daari (TDS upar dues_vendor_tds me). pay_referral_commission status 'paid' karta hai.
    (select coalesce(sum(rc.net_payable), 0)::bigint
       from public.referral_commissions rc
      where rc.tenant_id = v_tenant and rc.status = 'earned');
end;
$function$;


revoke all on function public.report_balance_sheet(date) from public, anon;
grant execute on function public.report_balance_sheet(date) to authenticated, service_role;

commit;
