-- deploy-peek: to_regprocedure('public.change_emi_down_payment_source(uuid,uuid,boolean,text,text)') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'owner_equity_movements' and column_name = 'emi_purchase_id') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_emi_asset_purchase(jsonb)') and prosrc like '%R-2395%')
-- deploy-key: r2395emidownpaymentsource
-- 20261103023500_r2395_emi_down_payment_source.sql
--
-- R-2395 (3 Nov 2026, staging): the Thar Roxx asset (cost ₹19,70,000, HDFC loan) had its
-- ₹2,00,000 down payment of 3 Feb 2026 posted as the app-made line "Down payment: Thar Roxx
-- (HDFC BANK)" on an FD account — but the owner paid it in cash, and that FD only opened on
-- 29 Aug 2026. No screen could change it, so the FD showed ₹2 L less than the bank.
--
-- ══ WHAT THIS ADDS ══════════════════════════════════════════════════════════════════════
--   change_emi_down_payment_source(p_purchase_id, p_account_id, p_paid_by_owner, p_partner, p_note)
--     Moves the down payment (down payment + processing fee — the one cash movement of the
--     R-1864 set-up) to another source, in ONE transaction:
--       • the old source is removed: the app-made 'manual' down-payment line (made by the app, so
--         removing it IS the reversal — not a user delete), or the owner-capital row;
--       • the new source is booked: a 'manual' line on any bank / FD / Petty Cash account
--         (matched 'emi' to the purchase, like the set-up), or — "Paid by owner" — an owner-equity
--         CAPITAL INTRODUCED row (R-1839) with no bank line: Dr Asset (down part) / Cr Capital.
--     Asset cost, the loan (financed), the schedule and every EMI are NOT touched.
--     Refused, nothing written: other company / not a money role (emi_guard, §17c); a loan with
--     no asset; no down payment; the down payment reconciled to an imported statement line
--     (un-reconcile it in Banking first — the bank says where it came from); a locked month
--     (tenants.books_locked_until, checked for every caller); the same source again; an account
--     opened after the payment date or closed before it; owner capital for a Pvt Ltd / no type
--     set (R-1870 rule) or a firm without the partner. One activity_log row (old → new).
--
--   Guard (card item 2): an app-made down-payment line is never dated before the account's
--   opening date (bank_accounts.opening_balance_date — an FD's start) or after it was closed.
--   record_emi_asset_purchase (body = R-1864's) now books the down payment through the same
--   helper, so the set-up refuses an FD that did not exist yet, and accepts "paid_by_owner".
--
--   owner_equity_movements: bank_account_id / bank_txn_id may be null ONLY for a row that is an
--   EMI down payment paid by the owner directly (emi_purchase_id set) — check constraint. Such a
--   row is removed only by change_emi_down_payment_source (or with its purchase, on delete
--   cascade): a delete from anywhere else is refused, so the asset never loses the other side
--   of its down payment.
--
-- Existing rows unchanged. Proof: supabase/tests/r2395_emi_down_payment_source.test.sql (one
-- rollback); R-1864 test unchanged in what it proves (its accounts now carry an opening date
-- before the purchase).

begin;

-- ── 1. Owner capital paid straight for an EMI down payment ──────────────────────────────────
alter table public.owner_equity_movements
  add column if not exists emi_purchase_id uuid references public.emi_purchases(id) on delete cascade;
alter table public.owner_equity_movements alter column bank_account_id drop not null;
alter table public.owner_equity_movements alter column bank_txn_id drop not null;
alter table public.owner_equity_movements drop constraint if exists owner_equity_movements_cash_r2395;
alter table public.owner_equity_movements add constraint owner_equity_movements_cash_r2395
  check ((bank_txn_id is not null and bank_account_id is not null)
         or (bank_txn_id is null and bank_account_id is null and emi_purchase_id is not null
             and kind = 'capital_introduced'));
create unique index if not exists owner_equity_movements_emi_purchase_r2395
  on public.owner_equity_movements (emi_purchase_id) where emi_purchase_id is not null;
comment on column public.owner_equity_movements.emi_purchase_id is
  'R-2395: the asset bought on EMI whose down payment the owner paid directly (capital introduced, no bank line).';

create or replace function public.tg_owner_equity_emi_down_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_name text;
begin
  /* R-2395: the owner-paid down payment changes only on Assets & EMIs. */
  if old.emi_purchase_id is null or coalesce(current_setting('app.r2395_down_move', true), '') = 'on' then
    return old;
  end if;
  select name into v_name from public.emi_purchases where id = old.emi_purchase_id;
  if not found then return old; end if;   -- the purchase itself is being deleted (cascade)
  raise exception 'This capital entry is the down payment of % — change where it was paid from on Accounting → Assets & EMIs (Schedule → Down payment).', v_name
    using errcode = '23503';
end;
$$;
revoke all on function public.tg_owner_equity_emi_down_guard() from public, anon, authenticated;

drop trigger if exists trg_owner_equity_emi_down_guard on public.owner_equity_movements;
create trigger trg_owner_equity_emi_down_guard
  before delete on public.owner_equity_movements
  for each row execute function public.tg_owner_equity_emi_down_guard();

-- ── 2. Internal helpers ──────────────────────────────────────────────────────────────────────
-- The account a down payment of p_date can come from: in the company, open on that day.
create or replace function public.emi_down_account(p_tenant uuid, p_account uuid, p_date date)
returns public.bank_accounts
language plpgsql stable security definer set search_path = public as $$
declare v public.bank_accounts;
begin
  -- R-2395
  if p_account is null then raise exception 'Pick the account the down payment was paid from'; end if;
  select * into v from public.bank_accounts where id = p_account and tenant_id = p_tenant;
  if not found then raise exception 'That bank / cash account is not in your company'; end if;
  if v.opening_balance_date is not null and p_date < v.opening_balance_date then
    raise exception '% starts on % — the down payment of % cannot have come from it. Pick the account it really left from, Petty Cash, or Paid by owner.',
      v.name, to_char(v.opening_balance_date, 'DD Mon YYYY'), to_char(p_date, 'DD Mon YYYY');
  end if;
  if v.closed_on is not null and p_date > v.closed_on then
    raise exception '% was closed on % — the down payment of % cannot have come from it.',
      v.name, to_char(v.closed_on, 'DD Mon YYYY'), to_char(p_date, 'DD Mon YYYY');
  end if;
  return v;
end;
$$;
revoke all on function public.emi_down_account(uuid, uuid, date) from public, anon, authenticated;

-- Books the down payment of p_p on its new source. Returns {kind, account_id, line_id, equity_id}.
create or replace function public.emi_down_book(
  p_tenant uuid, p_p public.emi_purchases, p_account uuid, p_by_owner boolean,
  p_partner text, p_note text, p_date date, p_amount integer
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_type    text;
  v_partner text := nullif(trim(coalesce(p_partner, '')), '');
  v_note    text := nullif(trim(coalesce(p_note, '')), '');
  v_acc     public.bank_accounts;
  v_txn     public.bank_transactions;
  v_eq      uuid;
begin
  -- R-2395
  if coalesce(p_by_owner, false) then
    select business_type into v_type from public.tenants where id = p_tenant;
    if v_type is null then
      raise exception 'Set your business type first: Settings, Company, Compliance profile, Business type. A company with no type set counts as Pvt Ltd, and a Pvt Ltd company has no owner capital entries.';
    end if;
    if v_type = 'pvt_ltd' then
      raise exception 'A Pvt Ltd company has no owner capital entries — money a director paid for the company is a director''s loan or share capital. Pick the account it was paid from instead.';
    end if;
    if v_type in ('partnership', 'llp') and v_partner is null then
      raise exception 'Pick the partner who paid the down payment.';
    end if;
    v_eq := gen_random_uuid();
    insert into public.owner_equity_movements
      (id, tenant_id, kind, movement_date, amount, bank_account_id, bank_txn_id, own_line, partner_name, note, created_by, emi_purchase_id)
    values
      (v_eq, p_tenant, 'capital_introduced', p_date, p_amount, null, null, false, v_partner,
       left(coalesce(v_note, 'Down payment paid by owner: ' || p_p.name || coalesce(' (' || p_p.lender || ')', '')), 1000),
       auth.uid(), p_p.id);
    update public.emi_purchases set down_bank_txn_id = null, down_account_id = null, updated_at = now() where id = p_p.id;
    return jsonb_build_object('kind', 'owner', 'account_id', null, 'line_id', null, 'equity_id', v_eq);
  end if;

  v_acc := public.emi_down_account(p_tenant, p_account, p_date);
  v_txn := public.emi_manual_line(p_tenant, v_acc.id, p_date, p_amount,
             'Down payment: ' || p_p.name || ' (' || coalesce(p_p.lender, '') || ')');
  perform public.emi_mark_line(v_txn.id, p_p.id);
  update public.emi_purchases set down_bank_txn_id = v_txn.id, down_account_id = v_acc.id, updated_at = now() where id = p_p.id;
  return jsonb_build_object('kind', 'account', 'account_id', v_acc.id, 'account_name', v_acc.name, 'line_id', v_txn.id, 'equity_id', null);
end;
$$;
revoke all on function public.emi_down_book(uuid, public.emi_purchases, uuid, boolean, text, text, date, integer) from public, anon, authenticated;

-- ── 3. Change where the down payment was paid from ───────────────────────────────────────────
create or replace function public.change_emi_down_payment_source(
  p_purchase_id   uuid,
  p_account_id    uuid default null,
  p_paid_by_owner boolean default false,
  p_partner       text default null,
  p_note          text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.emi_guard('change where a down payment was paid from');
  v_p       public.emi_purchases;
  v_line    public.bank_transactions;
  v_eq      public.owner_equity_movements;
  v_acc     public.bank_accounts;
  v_amt     integer;
  v_date    date;
  v_lock    date;
  v_owner   boolean := coalesce(p_paid_by_owner, false);
  v_before  jsonb;
  v_after   jsonb;
begin
  -- R-2395
  select * into v_p from public.emi_purchases where id = p_purchase_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That EMI purchase is not in your company'; end if;
  if coalesce(v_p.kind, 'asset') <> 'asset' then
    raise exception 'A loan with no asset has no down payment';
  end if;
  v_amt  := coalesce(v_p.down_payment, 0) + coalesce(v_p.processing_fee, 0) + coalesce(v_p.processing_fee_gst, 0);
  v_date := v_p.purchased_on;
  if v_amt <= 0 then raise exception 'This purchase has no down payment'; end if;
  if v_owner and p_account_id is not null then
    raise exception 'Pick either an account or Paid by owner — not both';
  end if;
  if not v_owner and p_account_id is null then
    raise exception 'Pick where the down payment was paid from';
  end if;

  -- Where it is now.
  if v_p.down_bank_txn_id is not null then
    select * into v_line from public.bank_transactions where id = v_p.down_bank_txn_id for update;
  end if;
  select * into v_eq from public.owner_equity_movements where emi_purchase_id = v_p.id for update;

  if v_line.id is not null then
    select * into v_acc from public.bank_accounts where id = v_line.bank_account_id;
    if v_line.source <> 'manual' then
      raise exception 'The down payment is reconciled to a statement line on % (%) — the bank shows it left from there. Un-reconcile that line in Banking first if it is wrong, then change it here.',
        coalesce(v_acc.name, 'an account'), to_char(v_line.txn_date, 'DD Mon YYYY');
    end if;
    v_amt  := coalesce(v_line.debit, v_amt);
    v_date := v_line.txn_date;
    v_before := jsonb_build_object('kind', 'account', 'account_id', v_line.bank_account_id, 'account_name', v_acc.name,
                                   'line_id', v_line.id, 'amount', v_amt, 'date', v_date);
  elsif v_eq.id is not null then
    v_amt  := v_eq.amount;
    v_date := v_eq.movement_date;
    v_before := jsonb_build_object('kind', 'owner', 'equity_id', v_eq.id, 'partner', v_eq.partner_name, 'amount', v_amt, 'date', v_date);
  else
    v_before := jsonb_build_object('kind', 'none', 'amount', v_amt, 'date', v_date);
  end if;

  -- Locked month: for every caller (the trigger only checks app logins).
  select books_locked_until into v_lock from public.tenants where id = v_tenant;
  if v_lock is not null and v_date <= v_lock then
    raise exception 'Books are locked up to % — the down payment of % is in a closed month. The owner can unlock it on Accounting → Month-end close, then change it.',
      to_char(v_lock, 'DD Mon YYYY'), to_char(v_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;

  -- The same source again.
  if v_owner and v_eq.id is not null then
    raise exception 'The down payment is already recorded as paid by the owner';
  end if;
  if not v_owner and v_line.id is not null and v_line.bank_account_id = p_account_id then
    raise exception 'The down payment is already on %', coalesce(v_acc.name, 'that account');
  end if;

  -- Remove the old source (made by the app: removing it is the reversal).
  perform set_config('app.r2395_down_move', 'on', true);
  update public.emi_purchases set down_bank_txn_id = null, down_account_id = null, updated_at = now() where id = v_p.id;
  if v_line.id is not null then
    delete from public.bank_transactions where id = v_line.id;
  end if;
  if v_eq.id is not null then
    delete from public.owner_equity_movements where id = v_eq.id;
  end if;

  -- Book the new one.
  select * into v_p from public.emi_purchases where id = v_p.id;
  v_after := public.emi_down_book(v_tenant, v_p, p_account_id, v_owner, p_partner, p_note, v_date, v_amt);
  perform set_config('app.r2395_down_move', '', true);

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, public.current_user_id(), 'emi_down_payment_moved', 'emi_purchase', v_p.id::text,
          'Down payment of ' || v_p.name || ' (₹' || v_amt || ', ' || to_char(v_date, 'DD Mon YYYY') || ') moved from '
            || case v_before ->> 'kind' when 'account' then coalesce(v_before ->> 'account_name', 'an account')
                                        when 'owner' then 'paid by owner' else 'nowhere' end
            || ' to '
            || case v_after ->> 'kind' when 'account' then coalesce(v_after ->> 'account_name', 'an account') else 'paid by owner (capital introduced)' end
            || ' — asset cost and loan unchanged',
          jsonb_build_object('before', v_before, 'after', v_after || jsonb_build_object('amount', v_amt, 'date', v_date)));

  return jsonb_build_object('purchase_id', v_p.id, 'amount', v_amt, 'date', v_date, 'before', v_before, 'after', v_after);
end;
$$;
revoke all on function public.change_emi_down_payment_source(uuid, uuid, boolean, text, text) from public, anon;
grant execute on function public.change_emi_down_payment_source(uuid, uuid, boolean, text, text) to authenticated, service_role;

-- ── 4. record_emi_asset_purchase — R-1864 body; down payment through emi_down_book ───────────
create or replace function public.record_emi_asset_purchase(p jsonb) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.emi_guard('record an asset bought on EMI');
  v_name     text := nullif(trim(coalesce(p ->> 'name', '')), '');
  v_block    text := coalesce(nullif(p ->> 'block', ''), 'computers');
  v_cost     integer := (p ->> 'cost')::integer;
  v_down     integer := greatest(coalesce((p ->> 'down_payment')::integer, 0), 0);
  v_fee      integer := greatest(coalesce((p ->> 'processing_fee')::integer, 0), 0);
  v_fee_gst  integer := greatest(coalesce((p ->> 'processing_fee_gst')::integer, 0), 0);
  v_date     date := (p ->> 'purchased_on')::date;
  v_lender   text := nullif(trim(coalesce(p ->> 'lender', '')), '');
  v_ref      text := nullif(trim(coalesce(p ->> 'lender_ref', '')), '');
  v_rate     numeric := nullif(p ->> 'interest_rate', '')::numeric;
  v_nocost   boolean := coalesce((p ->> 'no_cost')::boolean, false);
  v_account  uuid := nullif(p ->> 'account_id', '')::uuid;
  v_txn_id   uuid := nullif(p ->> 'down_bank_txn_id', '')::uuid;
  v_owner    boolean := coalesce((p ->> 'paid_by_owner')::boolean, false);   -- R-2395
  v_partner  text := nullif(trim(coalesce(p ->> 'partner', '')), '');        -- R-2395
  v_rows     jsonb := p -> 'schedule';
  v_fin      integer;
  v_cash     integer;
  v_id       uuid := gen_random_uuid();
  v_fee_id   text;
  v_cat      text;
  v_txn      public.bank_transactions;
  v_p        public.emi_purchases;
begin
  if v_name is null then raise exception 'Enter what was bought'; end if;
  if char_length(v_name) > 120 then raise exception 'Keep the item name under 120 characters'; end if;
  if v_block not in ('computers', 'plant', 'furniture', 'vehicles', 'building', 'intangible') then
    raise exception 'Pick the asset type';
  end if;
  if v_cost is null or v_cost <= 0 then raise exception 'Enter the cost of the item'; end if;
  if v_date is null then raise exception 'Enter the purchase date'; end if;
  if v_down > v_cost then raise exception 'The down payment (₹%) is more than the cost (₹%)', v_down, v_cost; end if;
  v_fin := v_cost - v_down;
  if v_fin <= 0 then raise exception 'Nothing is financed — add the item in the Fixed asset register instead'; end if;
  if v_lender is null then raise exception 'Enter the lender (bank / NBFC)'; end if;
  if v_nocost then v_rate := 0; end if;
  if v_rate is null then raise exception 'Enter the interest rate, or tick No-cost EMI'; end if;

  v_cat := case v_block when 'vehicles' then 'vehicle' when 'furniture' then 'furniture' when 'building' then 'property'
                        when 'intangible' then 'other' else 'equipment' end;
  v_cash := v_down + v_fee + v_fee_gst;

  if v_txn_id is not null then
    if v_owner then raise exception 'This bank line is the down payment — it was not paid by the owner'; end if;
    v_txn := public.emi_lock_debit_line(v_tenant, v_txn_id);
    if v_txn.debit <> v_cash then
      raise exception 'This bank line is ₹% but down payment + processing fee is ₹%', v_txn.debit, v_cash;
    end if;
  elsif v_cash > 0 and v_account is null and not v_owner then
    raise exception 'Pick the account the down payment was paid from';
  elsif v_cash > 0 and v_owner and v_account is not null then
    raise exception 'Pick either an account or Paid by owner — not both';
  elsif v_cash > 0 and not v_owner then
    -- R-2395: an FD / account that did not exist yet cannot have paid it (checked before any write).
    perform public.emi_down_account(v_tenant, v_account, v_date);
  end if;

  insert into public.emi_purchases
    (id, tenant_id, name, category, total_cost, down_payment, financed, emi_count, emi_amount, purchased_on,
     down_account_id, lender, notes, status, created_by, interest_rate, no_cost, first_emi_on,
     processing_fee, processing_fee_gst, lender_ref)
  values
    (v_id, v_tenant, v_name, v_cat, v_cost, v_down, v_fin, coalesce(jsonb_array_length(v_rows), 0),
     coalesce((v_rows -> 0 ->> 'emi')::integer, 0), v_date,
     case when v_owner then null else coalesce(v_txn.bank_account_id, v_account) end,
     v_lender, nullif(trim(coalesce(p ->> 'notes', '')), ''), 'active',
     public.current_user_id(), v_rate, v_nocost, (v_rows -> 0 ->> 'due_on')::date, v_fee, v_fee_gst, v_ref);

  perform public.emi_replace_unpaid_schedule(v_tenant, v_id, 1, v_fin, v_rows, v_nocost, v_date);

  -- The asset in the register: cost, put to use on the purchase date (depreciation from there).
  insert into public.fixed_assets (tenant_id, name, block, cost, put_to_use, emi_purchase_id, notes)
  values (v_tenant, v_name, v_block, v_cost, v_date, v_id, 'Bought on EMI — ' || v_lender);

  if v_fee + v_fee_gst > 0 then
    v_fee_id := public.emi_new_expense_id();
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description, bill_type)
    values (v_fee_id, v_tenant, 'Bank Charges', v_lender, v_date, v_fee + v_fee_gst, v_fee_gst, 'emi',
            'Loan processing fee — ' || v_name, case when v_fee_gst > 0 then 'gst' else 'none' end);
    update public.emi_purchases set fee_expense_id = v_fee_id where id = v_id;
  end if;

  if v_cash > 0 then
    if v_txn_id is not null then
      perform public.emi_mark_line(v_txn.id, v_id);
      update public.emi_purchases set down_bank_txn_id = v_txn.id where id = v_id;
    else
      select * into v_p from public.emi_purchases where id = v_id;
      perform public.emi_down_book(v_tenant, v_p, v_account, v_owner, v_partner, null, v_date, v_cash);
    end if;
  end if;

  return v_id;
end;
$$;
revoke all on function public.record_emi_asset_purchase(jsonb) from public, anon;
grant execute on function public.record_emi_asset_purchase(jsonb) to authenticated, service_role;

commit;
