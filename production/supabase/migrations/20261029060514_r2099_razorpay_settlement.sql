-- deploy-peek: to_regprocedure('public.reconcile_razorpay_settlement(uuid,jsonb)') is not null and to_regclass('public.razorpay_settlement_recons') is not null
-- deploy-key: r2099razorpaysettlement
-- 20261029060514_r2099_razorpay_settlement.sql
--
-- R-2099 (29 Oct 2026, from the R-2094 staging reconcile): a Razorpay settlement reaches the bank
-- as ONE credit ("NEFT CR-…-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-…") for many
-- customer payments, minus Razorpay's fee + GST on it, minus refunds. October had five such lines
-- and Banking → Reconcile had no way to book them.
--
-- The app fetches the settlement from Razorpay's API (src/lib/razorpay/settlement*.ts) and calls
-- reconcile_razorpay_settlement(txn, settlement) — ONE transaction:
--   • every Razorpay payment of the settlement is an app payment already (the webhook's
--     reference pay_…, or one the owner picked); each must be received/refunded, in this company,
--     not on any other bank line, and of exactly Razorpay's rupee amount;
--   • every refund in it is a payment the app already shows as refunded, full amount;
--   • the fee = the payments' cash − refunds − the bank credit (whole rupees), within rounding of
--     Razorpay's own fee; the part not already booked per payment (EXP-RZPFEE-<payment>, R-045)
--     is booked as ONE "Bank Charges" expense EXP-RZPFEE-STL-<settlement id> (vendor Razorpay,
--     GST on the fee as gst_paid → input credit when the Razorpay vendor carries a GSTIN, heads
--     from Razorpay's GSTIN state vs ours). The EXP-RZPFEE- prefix keeps it out of "payables" and
--     "paid but not in bank" in the balance sheet — Razorpay kept it from the settlement;
--   • the line is reconciled to its first receipt and every receipt carries payments.bank_txn_id
--     (the R-2098 convention: banked, not undeposited; left out of the per-payment shortfall);
--   • razorpay_settlement_recons / _items keep what was booked; a settlement, a Razorpay payment
--     or refund can be used once (unique) — a second click is refused, nothing written twice.
-- Un-reconciling the line (any path → bank_transactions.matched_to_* changes) removes the
-- settlement rows and its fee expense (trg_razorpay_settlement_line_unmatched); R-2098's trigger
-- frees the receipts.
--
-- Test: supabase/tests/r2099_razorpay_settlement.test.sql

begin;

-- R-2098 adds this column; repeated here (no-op when present) so this file stands on its own.
alter table public.payments
  add column if not exists bank_txn_id uuid references public.bank_transactions(id) on delete set null;

create table if not exists public.razorpay_settlement_recons (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  settlement_id  text not null check (settlement_id ~ '^setl_[A-Za-z0-9]+$'),
  bank_txn_id    uuid not null unique references public.bank_transactions(id) on delete cascade,
  utr            text,
  gross          integer not null,
  refunds        integer not null default 0,
  fee            integer not null,
  fee_gst        integer not null default 0,
  fee_expense_id text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (tenant_id, settlement_id)
);
comment on table public.razorpay_settlement_recons is
  'R-2099: a Razorpay settlement bank credit reconciled to the app''s payments (gross − refunds − fee = the line). One row per settlement; removed when the line is un-reconciled.';

create table if not exists public.razorpay_settlement_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  recon_id    uuid not null references public.razorpay_settlement_recons(id) on delete cascade,
  kind        text not null check (kind in ('payment', 'refund')),
  rzp_id      text not null,
  amount      integer not null,
  payment_ids uuid[] not null,
  unique (tenant_id, kind, rzp_id)
);
create index if not exists razorpay_settlement_items_recon_idx on public.razorpay_settlement_items (recon_id);
comment on table public.razorpay_settlement_items is
  'R-2099: each Razorpay payment / refund of a reconciled settlement and the app payment(s) it is. A Razorpay id is used once.';

alter table public.razorpay_settlement_recons enable row level security;
alter table public.razorpay_settlement_items enable row level security;
drop policy if exists razorpay_settlement_recons_tenant_read on public.razorpay_settlement_recons;
create policy razorpay_settlement_recons_tenant_read on public.razorpay_settlement_recons
  for select to authenticated using (tenant_id = (select public.current_tenant_id()));
drop policy if exists razorpay_settlement_items_tenant_read on public.razorpay_settlement_items;
create policy razorpay_settlement_items_tenant_read on public.razorpay_settlement_items
  for select to authenticated using (tenant_id = (select public.current_tenant_id()));
-- Cloud SQL has no BYPASSRLS: the service role needs its own policy.
drop policy if exists zzz_service_role_all on public.razorpay_settlement_recons;
create policy zzz_service_role_all on public.razorpay_settlement_recons as permissive for all to service_role
  using (true) with check (true);
drop policy if exists zzz_service_role_all on public.razorpay_settlement_items;
create policy zzz_service_role_all on public.razorpay_settlement_items as permissive for all to service_role
  using (true) with check (true);
revoke all on table public.razorpay_settlement_recons from anon;
revoke all on table public.razorpay_settlement_items from anon;
grant select on table public.razorpay_settlement_recons to authenticated;
grant select on table public.razorpay_settlement_items to authenticated;
grant all on table public.razorpay_settlement_recons to service_role;
grant all on table public.razorpay_settlement_items to service_role;

-- ── Un-reconcile → the settlement and its fee go ────────────────────────────────────────────
create or replace function public.tg_razorpay_settlement_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exp text;
begin
  /* R-2099: the line no longer carries the settlement — its fee expense and rows go with it
     (R-2098's trg_bank_split_line_unmatched frees the receipts). */
  if old.matched_to_type is not distinct from new.matched_to_type
     and old.matched_to_id is not distinct from new.matched_to_id then
    return new;
  end if;
  for v_exp in
    delete from public.razorpay_settlement_recons
     where tenant_id = old.tenant_id and bank_txn_id = old.id
    returning fee_expense_id
  loop
    if v_exp is not null then
      delete from public.expenses where tenant_id = old.tenant_id and id = v_exp;
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.tg_razorpay_settlement_line_unmatched() from public, anon, authenticated;

drop trigger if exists trg_razorpay_settlement_line_unmatched on public.bank_transactions;
create trigger trg_razorpay_settlement_line_unmatched
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_razorpay_settlement_line_unmatched();

-- ── The one-click reconcile ─────────────────────────────────────────────────────────────────
create or replace function public.reconcile_razorpay_settlement(p_txn_id uuid, p_settlement jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2099. p_settlement = {id, utr, fee_paise, tax_paise,
     payments: [{rzp_id, amount_paise, payment_ids: [uuid]}],
     refunds:  [{rzp_id, amount_paise, payment_ids: [uuid]}]}  — built from Razorpay's API by
   src/lib/razorpay/settlement-match.ts; every number is re-checked here against the app's rows. */
declare
  v_caller    uuid;
  v_trusted   boolean;
  v_txn       record;
  v_sid       text;
  v_item      jsonb;
  v_ids       uuid[];
  v_all_ids   uuid[] := array[]::uuid[];
  v_ref_ids   uuid[] := array[]::uuid[];
  v_first     uuid;
  v_n         integer;
  v_sum       integer;
  v_rzp_amt   integer;
  v_cash      integer := 0;
  v_refunds   integer := 0;
  v_fee_num   numeric;
  v_fee       integer;
  v_rzp_fee   integer;
  v_rzp_tax   integer;
  v_tol       integer;
  v_booked    integer;
  v_booked_g  integer;
  v_rest      integer;
  v_rest_gst  integer;
  v_exp_id    text := null;
  v_vendor    record;
  v_own_st    text;
  v_v_st      text;
  v_igst      integer;
  v_cgst      integer;
  v_sgst      integer;
  v_recon     uuid;
  v_rzp_ids   text[] := array[]::text[];
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
    raise exception 'Only a money-in (credit) bank line can be a Razorpay settlement.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  v_sid := p_settlement->>'id';
  if v_sid is null or v_sid !~ '^setl_[A-Za-z0-9]+$' then
    raise exception 'The Razorpay settlement id is missing. Fetch the settlement again.' using errcode = '22023';
  end if;
  if exists (select 1 from public.razorpay_settlement_recons r where r.tenant_id = v_txn.tenant_id and r.settlement_id = v_sid) then
    raise exception 'Razorpay settlement % is already reconciled to another bank line. Un-reconcile that line first if it was wrong.', v_sid
      using errcode = 'unique_violation';
  end if;
  if jsonb_typeof(p_settlement->'payments') is distinct from 'array' or jsonb_array_length(p_settlement->'payments') = 0 then
    raise exception 'This settlement has no payments to reconcile. Fetch it again.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_settlement->'payments') > 2000 then
    raise exception 'Too many payments in one settlement (%).', jsonb_array_length(p_settlement->'payments') using errcode = '22023';
  end if;
  if p_settlement ? 'refunds' and jsonb_typeof(p_settlement->'refunds') is distinct from 'array' then
    raise exception 'The refunds list is not valid. Fetch the settlement again.' using errcode = '22023';
  end if;

  /* Each Razorpay payment: the app payment(s) it is — this company, received (or since
     refunded), on no bank line, exactly Razorpay's rupees. */
  for v_item in select value from jsonb_array_elements(p_settlement->'payments') loop
    begin
      v_ids := array(select jsonb_array_elements_text(v_item->'payment_ids')::uuid);
      v_rzp_amt := round((v_item->>'amount_paise')::numeric / 100);
    exception when others then
      raise exception 'A payment in the settlement is not valid. Fetch the settlement again.' using errcode = '22023';
    end;
    if coalesce(cardinality(v_ids), 0) = 0 then
      raise exception 'Razorpay payment % has no app payment. Pick or record it first.', v_item->>'rzp_id' using errcode = '22023';
    end if;
    if v_ids && v_all_ids then
      raise exception 'One app payment is listed for two Razorpay payments (%). Fetch the settlement again.', v_item->>'rzp_id' using errcode = '22023';
    end if;
    if (v_item->>'rzp_id') = any(v_rzp_ids) then
      raise exception 'Razorpay payment % is listed twice.', v_item->>'rzp_id' using errcode = '22023';
    end if;
    v_rzp_ids := v_rzp_ids || (v_item->>'rzp_id');
    select count(*), coalesce(sum(p.amount - p.credit_applied), 0)::int into v_n, v_sum
      from public.payments p
     where p.tenant_id = v_txn.tenant_id and p.id = any(v_ids) and p.status in ('received', 'refunded');
    if v_n <> cardinality(v_ids) then
      raise exception 'The app payment for Razorpay payment % is not in your company or was deleted. Fetch the settlement again.', v_item->>'rzp_id'
        using errcode = 'no_data_found';
    end if;
    if v_sum <> v_rzp_amt then
      raise exception 'Razorpay says ₹% for % but the app recorded ₹%. Correct the payment, then fetch again.', v_rzp_amt, v_item->>'rzp_id', v_sum
        using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.payments p where p.tenant_id = v_txn.tenant_id and p.id = any(v_ids) and p.bank_txn_id is not null)
       or exists (select 1 from public.bank_transactions b
                   where b.tenant_id = v_txn.tenant_id and b.matched_to_type = 'payment'
                     and b.matched_to_id = any(array(select x::text from unnest(v_ids) x))) then
      raise exception 'The app payment for % is already reconciled to another bank line. Un-reconcile that line first if it was matched wrongly.', v_item->>'rzp_id'
        using errcode = 'check_violation';
    end if;
    v_all_ids := v_all_ids || v_ids;
    v_cash := v_cash + v_sum;
  end loop;

  /* Each refund: a payment the app already shows refunded, in full. */
  for v_item in select value from jsonb_array_elements(coalesce(p_settlement->'refunds', '[]'::jsonb)) loop
    begin
      v_ids := array(select jsonb_array_elements_text(v_item->'payment_ids')::uuid);
      v_rzp_amt := round((v_item->>'amount_paise')::numeric / 100);
    exception when others then
      raise exception 'A refund in the settlement is not valid. Fetch the settlement again.' using errcode = '22023';
    end;
    if coalesce(cardinality(v_ids), 0) = 0 then
      raise exception 'Razorpay refund % has no app payment. Record that payment and its refund first.', v_item->>'rzp_id' using errcode = '22023';
    end if;
    select count(*), coalesce(sum(p.amount - p.credit_applied), 0)::int into v_n, v_sum
      from public.payments p
     where p.tenant_id = v_txn.tenant_id and p.id = any(v_ids) and p.status = 'refunded';
    if v_n <> cardinality(v_ids) then
      raise exception 'Razorpay refund % is on a payment the app does not show as refunded. Use Refund on that payment (Payments page) first.', v_item->>'rzp_id'
        using errcode = 'check_violation';
    end if;
    if v_sum <> v_rzp_amt then
      raise exception 'Razorpay refunded ₹% (%) but the app''s refunded payment is ₹%. Partial refunds are booked by hand.', v_rzp_amt, v_item->>'rzp_id', v_sum
        using errcode = 'check_violation';
    end if;
    v_ref_ids := v_ref_ids || v_ids;
    v_refunds := v_refunds + v_sum;
  end loop;

  /* The fee is what is left: payments − refunds − what reached the bank. Razorpay's own figure
     must agree within rupee rounding (each item rounded once). */
  v_fee_num := v_cash - v_refunds - v_txn.credit;
  v_fee := round(v_fee_num);
  v_rzp_fee := round(coalesce((p_settlement->>'fee_paise')::numeric, 0) / 100);
  v_rzp_tax := round(coalesce((p_settlement->>'tax_paise')::numeric, 0) / 100);
  v_tol := 1 + ceil((jsonb_array_length(p_settlement->'payments') + jsonb_array_length(coalesce(p_settlement->'refunds', '[]'::jsonb)))::numeric / 2)::int;
  if v_fee < 0 then
    raise exception 'The payments (₹%) less refunds (₹%) are less than the ₹% that reached the bank. This is not the right settlement for this line.',
      v_cash, v_refunds, v_txn.credit using errcode = 'check_violation';
  end if;
  if abs(v_fee - v_rzp_fee) > v_tol then
    raise exception 'Payments ₹% − refunds ₹% − bank ₹% leaves ₹% of fee, but Razorpay says its fee is ₹%. Fetch the settlement again.',
      v_cash, v_refunds, v_txn.credit, v_fee, v_rzp_fee using errcode = 'check_violation';
  end if;

  /* Fees already booked on these payments one by one (R-045 webhook) are not booked again. */
  select coalesce(sum(e.amount), 0)::int, coalesce(sum(e.gst_paid), 0)::int into v_booked, v_booked_g
    from public.expenses e
   where e.tenant_id = v_txn.tenant_id
     and e.id = any(array(select 'EXP-RZPFEE-' || x::text from unnest(v_all_ids) x));
  v_rest := v_fee - v_booked;
  if v_rest < 0 then
    raise exception 'Razorpay fees of ₹% are already booked on these payments, more than the ₹% this settlement kept. Check the fee expenses (Expenses → Bank Charges), then try again.',
      v_booked, v_fee using errcode = 'check_violation';
  end if;
  v_rest_gst := least(v_rest, greatest(0, v_rzp_tax - v_booked_g));

  if v_rest > 0 then
    select v.id, v.gstin into v_vendor
      from public.vendors v
     where v.tenant_id = v_txn.tenant_id and v.name ilike '%razorpay%'
     order by (coalesce(btrim(v.gstin), '') <> '') desc, v.created_at asc
     limit 1;
    select coalesce(nullif(btrim(t.state_code), ''), case when length(btrim(coalesce(t.gstin, ''))) = 15 then left(btrim(t.gstin), 2) end)
      into v_own_st from public.tenants t where t.id = v_txn.tenant_id;
    v_v_st := case when length(btrim(coalesce(v_vendor.gstin, ''))) = 15 then left(btrim(v_vendor.gstin), 2) end;
    if v_rest_gst = 0 then
      v_igst := 0; v_cgst := 0; v_sgst := 0;
    elsif v_own_st is null or v_v_st is null then
      v_igst := null; v_cgst := null; v_sgst := null;      -- unknown: the GST report flags it, no guess
    elsif v_own_st = v_v_st then
      v_cgst := round(v_rest_gst / 2.0); v_sgst := v_rest_gst - v_cgst; v_igst := 0;
    else
      v_igst := v_rest_gst; v_cgst := 0; v_sgst := 0;
    end if;

    v_exp_id := 'EXP-RZPFEE-STL-' || v_sid;
    insert into public.expenses
      (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, igst, cgst, sgst,
       bill_type, paid, paid_date, payment_method, description, notes)
    values
      (v_exp_id, v_txn.tenant_id, 'Bank Charges', 'Razorpay', v_vendor.id, v_txn.txn_date, v_rest, v_rest_gst,
       v_igst, v_cgst, v_sgst, 'gst', true, v_txn.txn_date, 'razorpay',
       'Razorpay fee on settlement ' || v_sid,
       format('Booked from the Razorpay settlement (R-2099): payments ₹%s − refunds ₹%s − bank ₹%s = fee ₹%s incl. GST; ₹%s of it was already booked on single payments. Razorpay''s monthly tax invoice is the bill for this GST.',
              v_cash, v_refunds, v_txn.credit, v_fee, v_booked));
  end if;

  /* The line → its first receipt (every existing reader); all receipts → the line. Reconcile
     FIRST: R-2098's trigger clears bank_txn_id when a line's match changes. */
  select p.id into v_first from public.payments p
   where p.tenant_id = v_txn.tenant_id and p.id = any(v_all_ids)
   order by (p.status = 'received') desc, p.received_at asc, p.id
   limit 1;
  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_first::text, 'manual');
  update public.payments set bank_txn_id = p_txn_id
   where tenant_id = v_txn.tenant_id and id = any(v_all_ids);
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_all_ids) then
    raise exception 'R-2099: linked % of % payments to the bank line — nothing was saved.', v_n, cardinality(v_all_ids);
  end if;

  insert into public.razorpay_settlement_recons
    (tenant_id, settlement_id, bank_txn_id, utr, gross, refunds, fee, fee_gst, fee_expense_id, created_by)
  values
    (v_txn.tenant_id, v_sid, p_txn_id, nullif(btrim(p_settlement->>'utr'), ''), v_cash, v_refunds, v_fee,
     least(v_fee, v_rzp_tax), v_exp_id, auth.uid())
  returning id into v_recon;

  insert into public.razorpay_settlement_items (tenant_id, recon_id, kind, rzp_id, amount, payment_ids)
  select v_txn.tenant_id, v_recon, 'payment', x->>'rzp_id', round((x->>'amount_paise')::numeric / 100),
         array(select jsonb_array_elements_text(x->'payment_ids')::uuid)
    from jsonb_array_elements(p_settlement->'payments') x;
  insert into public.razorpay_settlement_items (tenant_id, recon_id, kind, rzp_id, amount, payment_ids)
  select v_txn.tenant_id, v_recon, 'refund', x->>'rzp_id', round((x->>'amount_paise')::numeric / 100),
         array(select jsonb_array_elements_text(x->'payment_ids')::uuid)
    from jsonb_array_elements(coalesce(p_settlement->'refunds', '[]'::jsonb)) x;

  return jsonb_build_object(
    'kind',           'razorpay_settlement',
    'settlement_id',  v_sid,
    'amount',         v_txn.credit,
    'payments',       cardinality(v_all_ids),
    'gross',          v_cash,
    'refunds',        v_refunds,
    'fee',            v_fee,
    'fee_booked_now', v_rest,
    'fee_gst_now',    v_rest_gst,
    'fee_expense_id', v_exp_id,
    'payment_id',     v_first);
end;
$$;
revoke all on function public.reconcile_razorpay_settlement(uuid, jsonb) from public, anon;
grant execute on function public.reconcile_razorpay_settlement(uuid, jsonb) to authenticated, service_role;
comment on function public.reconcile_razorpay_settlement(uuid, jsonb) is
  'R-2099: one Razorpay settlement bank credit → its app payments (payments.bank_txn_id, line matched to the first), refunds checked as already refunded, the unbooked fee + GST as one Bank Charges expense EXP-RZPFEE-STL-<settlement>. One transaction; a settlement / Razorpay id is used once. Owner/manager/accountant/billing; tenant fail-closed.';

commit;
