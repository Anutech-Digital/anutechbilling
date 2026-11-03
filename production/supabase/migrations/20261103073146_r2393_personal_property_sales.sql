-- deploy-peek: (to_regclass('public.personal_property_sales') is not null and to_regclass('public.personal_property_sale_receipts') is not null and to_regprocedure('public.personal_property_sale_cancel(uuid,date,bigint,uuid,text)') is not null and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'personal_property_sale_receipts' and policyname = 'personal_property_sale_receipts_service_role'))
-- deploy-key: r2393personalpropertysales
-- R-2393 (goal G-PERSONAL, 3 Nov 2026): Private Vault → selling a property.
--
-- Pardeep (3 Nov): "isme property sell karta hai aur sell karne ki poori process jaise byana
-- ko handle karna kaise record karenge". A byana could be noted (R-2386 owe/hold) but there
-- was no sale deal: agreed price, staged payments, registry, the buyer's TDS and the
-- capital-gains working were nowhere.
--
-- What this adds
--   * personal_holdings.sold_on — the registry day; a sold holding leaves net worth
--     (lib/vault/personal/net-worth.ts). Plus unique (id, owner_user_id) for owner-safe FKs.
--   * personal_property_sales — one deal per real-estate holding (at most one that is not
--     cancelled): whose property it is (seller_contact_id null = the owner; else a family
--     member from R-2392 People — whose income the gain is), buyer (contact_id + party, the
--     R-2392 party trigger keeps the name), agreement date, agreed price, stamp-duty value,
--     purchase date + cost + improvements + transfer expenses (for the capital-gains estimate,
--     computed in code: lib/vault/personal/property-sale.ts), status agreement → registered /
--     cancelled, registry date + TDS the buyer deducted (s.194-IA), cancel: refunded / forfeited.
--   * personal_property_sale_receipts — byana / instalment / final payment, with mode
--     (bank / cheque / cash), the account it went into, and either
--       - owe_hold_id: the R-2386 advance moved into the deal (that entry is settled as
--         'converted_to_sale'; no new ledger row — its cash was already counted), or
--       - tx_id: a personal_transactions 'transfer_in' (category 'Property sale') into the
--         account — the cash enters the account's balance; R-2394 reconcile can 'match' a
--         bank line to it. Sale money is capital, not income, so it is a transfer.
--   * RPCs (SECURITY INVOKER — the owner RLS decides what exists; §17b one call each):
--       personal_property_sale_add_receipt(...)    receipt (+ ledger row / owe-hold settle)
--       personal_property_sale_delete_receipt(id)  undo (re-opens a moved owe-hold entry)
--       personal_property_sale_register(...)       registry: optional final payment, TDS,
--                                                  deal registered, holding sold_on
--       personal_property_sale_cancel(...)         refund (transfer_out) and/or forfeit the
--                                                  rest ('other_income', Income from other
--                                                  sources s.56(2)(ix), no account — the cash
--                                                  is already in the accounts)
--   * vault_contact_rename_party() (R-2392 trigger) also renames the buyer on sale deals; the
--     R-2392 vault_contact_fill_party trigger is reused on the deal table (no second rule).
--
-- Net worth: money received on a deal still at 'agreement' is owed to the buyer until the
-- registry — the screens add it to the R-2386 "I owe / hold for others" total
-- (openSaleAdvances). Registered → the holding is sold (out), the money is in the accounts.
--
-- Tax wording / rates are an estimate pending the CA (card needsDecision).
-- Privacy rule unchanged (20260819170000_owner_personal_vault.sql):
--     owner_user_id = auth.uid()  AND  tenant_id = current_tenant_id()
-- plus the R-450 service_role policy. Date defaults are public.ist_today() (R-2391).

begin;

-- ─── 1. holdings: sold_on + owner-safe key ─────────────────────────────────
alter table public.personal_holdings
  add column if not exists sold_on date;

comment on column public.personal_holdings.sold_on is
  'R-2393: the registry date of the property sale (personal_property_sales). A sold holding is left out of net worth.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'personal_holdings_id_owner_key') then
    alter table public.personal_holdings
      add constraint personal_holdings_id_owner_key unique (id, owner_user_id);
  end if;
end $$;

-- ─── 2. sale deals ─────────────────────────────────────────────────────────
create table if not exists public.personal_property_sales (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  owner_user_id       uuid not null references public.users(id) on delete cascade,
  holding_id          uuid not null,
  seller_contact_id   uuid,
  contact_id          uuid,
  party               text not null check (length(btrim(party)) between 1 and 120),
  agreement_date      date not null default public.ist_today(),
  agreed_price        bigint not null check (agreed_price > 0 and agreed_price <= 1000000000000),
  stamp_value         bigint check (stamp_value is null or (stamp_value > 0 and stamp_value <= 1000000000000)),
  acquired_on         date,
  cost_of_acquisition bigint not null default 0 check (cost_of_acquisition between 0 and 1000000000000),
  improvement_cost    bigint not null default 0 check (improvement_cost between 0 and 1000000000000),
  transfer_expenses   bigint not null default 0 check (transfer_expenses between 0 and 1000000000000),
  status              text not null default 'agreement' check (status in ('agreement', 'registered', 'cancelled')),
  registry_date       date,
  tds_deducted        bigint not null default 0 check (tds_deducted between 0 and 1000000000000),
  cancelled_on        date,
  refunded            bigint not null default 0 check (refunded >= 0),
  forfeited           bigint not null default 0 check (forfeited >= 0),
  refund_tx_id        uuid references public.personal_transactions(id) on delete set null,
  forfeit_tx_id       uuid references public.personal_transactions(id) on delete set null,
  note                text check (note is null or length(note) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint personal_property_sales_registered_check check (
    (status = 'registered') = (registry_date is not null)),
  constraint personal_property_sales_cancelled_check check (
    (status = 'cancelled') = (cancelled_on is not null)),
  constraint personal_property_sales_id_owner_key unique (id, owner_user_id),
  constraint personal_property_sales_holding_owner_fkey
    foreign key (holding_id, owner_user_id)
    references public.personal_holdings (id, owner_user_id)
    on delete restrict,
  constraint personal_property_sales_seller_owner_fkey
    foreign key (seller_contact_id, owner_user_id)
    references public.personal_contacts (id, owner_user_id)
    on delete set null (seller_contact_id),
  constraint personal_property_sales_contact_owner_fkey
    foreign key (contact_id, owner_user_id)
    references public.personal_contacts (id, owner_user_id)
    on delete set null (contact_id)
);

comment on table public.personal_property_sales is
  'R-2393: the sale of one Private Vault property (personal_holdings) — buyer, agreed price, stamp-duty value, cost for the capital-gains estimate, agreement → registered (TDS 194-IA by the buyer) / cancelled (refund / forfeit). Private to owner_user_id.';
comment on column public.personal_property_sales.seller_contact_id is
  'R-2393: whose property it is when not the owner (a family member from People) — the capital gain is that person''s income. Null = the owner.';
comment on column public.personal_property_sales.stamp_value is
  'R-2393: stamp-duty (circle) value. s.50C uses it when it is more than 110% of the agreed price; TDS 194-IA is on the higher of the two.';
comment on column public.personal_property_sales.tds_deducted is
  'R-2393: TDS the buyer deducted (s.194-IA, Form 26QB) — the seller''s tax credit, seen in 26AS.';

-- At most one live (not cancelled) deal per property.
create unique index if not exists personal_property_sales_one_live_idx
  on public.personal_property_sales (holding_id) where status <> 'cancelled';
create index if not exists personal_property_sales_owner_idx
  on public.personal_property_sales (owner_user_id, status, agreement_date desc);

-- ─── 3. receipts ───────────────────────────────────────────────────────────
create table if not exists public.personal_property_sale_receipts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  sale_id       uuid not null,
  kind          text not null check (kind in ('byana', 'instalment', 'final')),
  received_on   date not null default public.ist_today(),
  amount        bigint not null check (amount > 0 and amount <= 1000000000000),
  mode          text not null check (mode in ('bank', 'cheque', 'cash')),
  account_id    uuid,
  owe_hold_id   uuid,
  tx_id         uuid references public.personal_transactions(id) on delete set null,
  note          text check (note is null or length(note) <= 500),
  created_at    timestamptz not null default now(),
  constraint personal_property_sale_receipts_sale_owner_fkey
    foreign key (sale_id, owner_user_id)
    references public.personal_property_sales (id, owner_user_id)
    on delete cascade,
  constraint personal_property_sale_receipts_account_owner_fkey
    foreign key (account_id, owner_user_id)
    references public.personal_accounts (id, owner_user_id)
    on delete set null (account_id),
  constraint personal_property_sale_receipts_owe_hold_owner_fkey
    foreign key (owe_hold_id, owner_user_id)
    references public.personal_owe_hold (id, owner_user_id)
    on delete set null (owe_hold_id)
);

comment on table public.personal_property_sale_receipts is
  'R-2393: money received on a property sale — byana / instalment / final payment, mode bank / cheque / cash. owe_hold_id = an R-2386 advance moved into the deal; tx_id = the transfer_in ledger row that put the money in an account. Written by the personal_property_sale_* RPCs. Private to owner_user_id.';

create unique index if not exists personal_property_sale_receipts_owe_hold_idx
  on public.personal_property_sale_receipts (owe_hold_id) where owe_hold_id is not null;
create index if not exists personal_property_sale_receipts_sale_idx
  on public.personal_property_sale_receipts (sale_id, received_on);

-- ─── 4. RLS (owner only) + R-450 service_role ──────────────────────────────
alter table public.personal_property_sales          enable row level security;
alter table public.personal_property_sale_receipts  enable row level security;

drop policy if exists personal_property_sales_all on public.personal_property_sales;
create policy personal_property_sales_all on public.personal_property_sales
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

drop policy if exists personal_property_sales_service_role on public.personal_property_sales;
create policy personal_property_sales_service_role on public.personal_property_sales
  for all to service_role using (true) with check (true);

drop policy if exists personal_property_sale_receipts_all on public.personal_property_sale_receipts;
create policy personal_property_sale_receipts_all on public.personal_property_sale_receipts
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

drop policy if exists personal_property_sale_receipts_service_role on public.personal_property_sale_receipts;
create policy personal_property_sale_receipts_service_role on public.personal_property_sale_receipts
  for all to service_role using (true) with check (true);

revoke all on public.personal_property_sales, public.personal_property_sale_receipts from anon, public;
-- Receipts are written only through the RPCs (ledger row / owe-hold settle in the same call).
grant select, insert, update, delete on public.personal_property_sales to authenticated;
grant select, insert, update, delete on public.personal_property_sale_receipts to authenticated;
grant all on public.personal_property_sales, public.personal_property_sale_receipts to service_role;

-- ─── 5. buyer name follows the R-2392 contact (reuse the R-2392 triggers) ──
drop trigger if exists personal_property_sales_contact_party on public.personal_property_sales;
create trigger personal_property_sales_contact_party
  before insert or update of contact_id, party on public.personal_property_sales
  for each row execute function public.vault_contact_fill_party();

-- Latest definition is 20261103003100_r2392_personal_contacts.sql; + the sale deals line.
create or replace function public.vault_contact_rename_party()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.name is distinct from old.name then
    update public.personal_loans          set party = new.name where contact_id = new.id and owner_user_id = new.owner_user_id;
    update public.personal_owe_hold       set party = new.name where contact_id = new.id and owner_user_id = new.owner_user_id;
    update public.personal_transactions   set party = new.name where contact_id = new.id and owner_user_id = new.owner_user_id;
    update public.personal_property_sales set party = new.name where contact_id = new.id and owner_user_id = new.owner_user_id;
  end if;
  return new;
end;
$$;

comment on function public.vault_contact_rename_party() is
  'R-2392 trigger (+ R-2393 sale deals): renaming a personal contact renames the party on every linked loan, owe/hold, transaction and property-sale row.';

-- ─── 6. add a receipt ──────────────────────────────────────────────────────
-- p_owe_hold_id set = move that open R-2386 advance into the deal (its amount, date and
-- account; p_amount may be null). Else p_amount > 0; with an account a transfer_in row is made.
-- Returns {receipt_id, received_total, cash_warning}.
create or replace function public.personal_property_sale_add_receipt(
  p_sale_id     uuid,
  p_kind        text,
  p_received_on date   default null,
  p_amount      bigint default null,
  p_mode        text   default 'bank',
  p_account_id  uuid   default null,
  p_owe_hold_id uuid   default null,
  p_note        text   default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_sale    public.personal_property_sales%rowtype;
  v_hold    public.personal_owe_hold%rowtype;
  v_on      date := coalesce(p_received_on, public.ist_today());
  v_amount  bigint := p_amount;
  v_account uuid := p_account_id;
  v_mode    text := coalesce(p_mode, 'bank');
  v_got     bigint;
  v_tx      uuid;
  v_rec     uuid;
  v_label   text;
begin
  select * into v_sale from public.personal_property_sales
   where id = p_sale_id and owner_user_id = v_uid for update;
  if not found then
    raise exception 'Sale not found.' using errcode = 'P0002';
  end if;
  if v_sale.status = 'cancelled' then
    raise exception 'This sale was cancelled — no more payments can be added.' using errcode = 'P0001';
  end if;
  if p_kind is null or p_kind not in ('byana', 'instalment', 'final') then
    raise exception 'Unknown payment type %.', coalesce(p_kind, 'null') using errcode = '22023';
  end if;
  if v_mode not in ('bank', 'cheque', 'cash') then
    raise exception 'Mode must be bank, cheque or cash.' using errcode = '22023';
  end if;

  if p_owe_hold_id is not null then
    select * into v_hold from public.personal_owe_hold
     where id = p_owe_hold_id and owner_user_id = v_uid for update;
    if not found then
      raise exception 'Pick one of your open advances.' using errcode = 'P0002';
    end if;
    if v_hold.kind <> 'advance_received' or v_hold.status <> 'open' then
      raise exception 'Only an open "Advance received for a sale" can be moved into the sale.' using errcode = '22023';
    end if;
    v_amount  := v_hold.amount;
    v_on      := v_hold.occurred_on;
    v_account := coalesce(v_hold.account_id, p_account_id);
  end if;

  if v_amount is null or v_amount <= 0 then
    raise exception 'Enter the amount received.' using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0) into v_got
    from public.personal_property_sale_receipts where sale_id = v_sale.id;
  if v_got + v_amount + v_sale.tds_deducted > v_sale.agreed_price then
    raise exception 'That is more than the price: ₹% received + ₹% now is above the agreed ₹%.',
      v_got, v_amount, v_sale.agreed_price using errcode = '22023';
  end if;

  if p_owe_hold_id is not null then
    update public.personal_owe_hold
       set status = 'settled', settled_on = v_on, settled_how = 'converted_to_sale',
           settle_note = left('Moved into the property sale to ' || v_sale.party, 500), updated_at = now()
     where id = v_hold.id;
  elsif v_account is not null then
    v_label := case p_kind when 'byana' then 'Byana' when 'instalment' then 'Instalment' else 'Final payment' end;
    insert into public.personal_transactions
      (tenant_id, owner_user_id, kind, category, amount, occurred_on, account_id, note, party, contact_id)
    values (v_sale.tenant_id, v_uid, 'transfer_in', 'Property sale', v_amount, v_on, v_account,
            left(v_label || ' — property sale' || coalesce(' · ' || nullif(btrim(p_note), ''), ''), 500),
            left(v_sale.party, 120), v_sale.contact_id)
    returning id into v_tx;
  end if;

  insert into public.personal_property_sale_receipts
    (tenant_id, owner_user_id, sale_id, kind, received_on, amount, mode, account_id, owe_hold_id, tx_id, note)
  values (v_sale.tenant_id, v_uid, v_sale.id, p_kind, v_on, v_amount, v_mode, v_account, p_owe_hold_id, v_tx,
          nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  returning id into v_rec;

  update public.personal_property_sales set updated_at = now() where id = v_sale.id;

  return jsonb_build_object(
    'receipt_id', v_rec,
    'received_total', v_got + v_amount,
    'cash_warning', v_mode = 'cash' and v_amount >= 20000);
end;
$$;

comment on function public.personal_property_sale_add_receipt(uuid, text, date, bigint, text, uuid, uuid, text) is
  'R-2393: add a byana / instalment / final payment to a property sale in one transaction — a transfer_in ledger row into the account, or (p_owe_hold_id) the R-2386 advance moved in and settled as converted_to_sale. Refused above the agreed price and on a cancelled sale. cash_warning = cash of ₹20,000+ (s.269SS/269ST). SECURITY INVOKER.';

revoke all on function public.personal_property_sale_add_receipt(uuid, text, date, bigint, text, uuid, uuid, text) from public, anon;
grant execute on function public.personal_property_sale_add_receipt(uuid, text, date, bigint, text, uuid, uuid, text) to authenticated, service_role;

-- ─── 7. delete a receipt ───────────────────────────────────────────────────
create or replace function public.personal_property_sale_delete_receipt(p_receipt_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_rec  public.personal_property_sale_receipts%rowtype;
  v_st   text;
begin
  select * into v_rec from public.personal_property_sale_receipts
   where id = p_receipt_id and owner_user_id = v_uid for update;
  if not found then
    raise exception 'Payment not found.' using errcode = 'P0002';
  end if;
  select status into v_st from public.personal_property_sales where id = v_rec.sale_id for update;
  if v_st = 'cancelled' then
    raise exception 'This sale was cancelled — its payments are kept as they were.' using errcode = 'P0001';
  end if;

  delete from public.personal_property_sale_receipts where id = v_rec.id;
  if v_rec.tx_id is not null then
    delete from public.personal_transactions where id = v_rec.tx_id and owner_user_id = v_uid;
  end if;
  -- A moved advance is open again in "Money I owe / hold for others".
  if v_rec.owe_hold_id is not null then
    update public.personal_owe_hold
       set status = 'open', settled_on = null, settled_how = null, settle_note = null, updated_at = now()
     where id = v_rec.owe_hold_id and owner_user_id = v_uid and settled_how = 'converted_to_sale';
  end if;

  return jsonb_build_object('receipt_id', v_rec.id, 'owe_hold_reopened', v_rec.owe_hold_id is not null);
end;
$$;

comment on function public.personal_property_sale_delete_receipt(uuid) is
  'R-2393: remove a property-sale payment and the ledger row it made; a moved R-2386 advance is re-opened. Not on a cancelled sale. SECURITY INVOKER.';

revoke all on function public.personal_property_sale_delete_receipt(uuid) from public, anon;
grant execute on function public.personal_property_sale_delete_receipt(uuid) to authenticated, service_role;

-- ─── 8. registry ───────────────────────────────────────────────────────────
-- Optional final payment (p_final_amount > 0) is added first, then: TDS recorded, deal
-- registered, the property marked sold on the registry date.
create or replace function public.personal_property_sale_register(
  p_sale_id          uuid,
  p_registry_date    date   default null,
  p_tds_deducted     bigint default 0,
  p_final_amount     bigint default null,
  p_final_mode       text   default 'bank',
  p_final_account_id uuid   default null,
  p_note             text   default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_sale public.personal_property_sales%rowtype;
  v_on   date := coalesce(p_registry_date, public.ist_today());
  v_tds  bigint := coalesce(p_tds_deducted, 0);
  v_got  bigint;
begin
  select * into v_sale from public.personal_property_sales
   where id = p_sale_id and owner_user_id = v_uid for update;
  if not found then
    raise exception 'Sale not found.' using errcode = 'P0002';
  end if;
  if v_sale.status <> 'agreement' then
    raise exception 'This sale is already %.', case v_sale.status when 'registered' then 'registered' else 'cancelled' end
      using errcode = 'P0001';
  end if;
  if v_on < v_sale.agreement_date then
    raise exception 'The registry date cannot be before the agreement date (%).', v_sale.agreement_date using errcode = '22023';
  end if;
  if v_tds < 0 or v_tds > v_sale.agreed_price then
    raise exception 'TDS must be between ₹0 and the agreed price.' using errcode = '22023';
  end if;

  -- TDS first, so the "above the price" check of the final payment counts it.
  update public.personal_property_sales set tds_deducted = v_tds where id = v_sale.id;

  if coalesce(p_final_amount, 0) > 0 then
    perform public.personal_property_sale_add_receipt(
      v_sale.id, 'final', v_on, p_final_amount, p_final_mode, p_final_account_id, null, p_note);
  end if;

  update public.personal_property_sales
     set status = 'registered', registry_date = v_on, updated_at = now(),
         note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 500), ''), note)
   where id = v_sale.id;

  update public.personal_holdings
     set sold_on = v_on, updated_at = now()
   where id = v_sale.holding_id and owner_user_id = v_uid;

  select coalesce(sum(amount), 0) into v_got
    from public.personal_property_sale_receipts where sale_id = v_sale.id;

  return jsonb_build_object(
    'sale_id', v_sale.id, 'registry_date', v_on, 'received_total', v_got, 'tds_deducted', v_tds,
    'balance_due', greatest(v_sale.agreed_price - v_got - v_tds, 0));
end;
$$;

comment on function public.personal_property_sale_register(uuid, date, bigint, bigint, text, uuid, text) is
  'R-2393: record the registry of a property sale in one transaction — optional final payment (ledger row), TDS the buyer deducted (s.194-IA), deal registered, holding sold_on = registry date (leaves net worth). SECURITY INVOKER.';

revoke all on function public.personal_property_sale_register(uuid, date, bigint, bigint, text, uuid, text) from public, anon;
grant execute on function public.personal_property_sale_register(uuid, date, bigint, bigint, text, uuid, text) to authenticated, service_role;

-- ─── 9. cancel ─────────────────────────────────────────────────────────────
-- p_refund (0..received) goes back to the buyer (transfer_out from p_refund_account_id when
-- given); the rest of what was received is forfeited → 'other_income' (Income from other
-- sources, s.56(2)(ix)) with no account (the cash is already in the accounts).
create or replace function public.personal_property_sale_cancel(
  p_sale_id           uuid,
  p_cancelled_on      date   default null,
  p_refund            bigint default 0,
  p_refund_account_id uuid   default null,
  p_note              text   default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_sale    public.personal_property_sales%rowtype;
  v_on      date := coalesce(p_cancelled_on, public.ist_today());
  v_got     bigint;
  v_refund  bigint := coalesce(p_refund, 0);
  v_forfeit bigint;
  v_rtx     uuid;
  v_ftx     uuid;
begin
  select * into v_sale from public.personal_property_sales
   where id = p_sale_id and owner_user_id = v_uid for update;
  if not found then
    raise exception 'Sale not found.' using errcode = 'P0002';
  end if;
  if v_sale.status <> 'agreement' then
    raise exception 'Only a sale that is not yet registered can be cancelled.' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into v_got
    from public.personal_property_sale_receipts where sale_id = v_sale.id;
  if v_refund < 0 or v_refund > v_got then
    raise exception 'The refund must be between ₹0 and the ₹% received.', v_got using errcode = '22023';
  end if;
  v_forfeit := v_got - v_refund;

  if v_refund > 0 and p_refund_account_id is not null then
    insert into public.personal_transactions
      (tenant_id, owner_user_id, kind, category, amount, occurred_on, account_id, note, party, contact_id)
    values (v_sale.tenant_id, v_uid, 'transfer_out', 'Property sale refund', v_refund, v_on, p_refund_account_id,
            left('Advance refunded — sale cancelled' || coalesce(' · ' || nullif(btrim(p_note), ''), ''), 500),
            left(v_sale.party, 120), v_sale.contact_id)
    returning id into v_rtx;
  end if;

  if v_forfeit > 0 then
    insert into public.personal_transactions
      (tenant_id, owner_user_id, kind, category, income_source, amount, occurred_on, account_id, note, party, contact_id)
    values (v_sale.tenant_id, v_uid, 'other_income', 'Forfeited advance', 'other', v_forfeit, v_on, null,
            left('Advance forfeited — sale cancelled (Income from other sources, s.56(2)(ix))'
                 || coalesce(' · ' || nullif(btrim(p_note), ''), ''), 500),
            left(v_sale.party, 120), v_sale.contact_id)
    returning id into v_ftx;
  end if;

  update public.personal_property_sales
     set status = 'cancelled', cancelled_on = v_on, refunded = v_refund, forfeited = v_forfeit,
         refund_tx_id = v_rtx, forfeit_tx_id = v_ftx, updated_at = now(),
         note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 500), ''), note)
   where id = v_sale.id;

  return jsonb_build_object('sale_id', v_sale.id, 'received_total', v_got, 'refunded', v_refund, 'forfeited', v_forfeit);
end;
$$;

comment on function public.personal_property_sale_cancel(uuid, date, bigint, uuid, text) is
  'R-2393: cancel a property sale not yet registered — refund (transfer_out from the account) and/or forfeit the rest (other_income "Forfeited advance", Income from other sources s.56(2)(ix)). SECURITY INVOKER.';

revoke all on function public.personal_property_sale_cancel(uuid, date, bigint, uuid, text) from public, anon;
grant execute on function public.personal_property_sale_cancel(uuid, date, bigint, uuid, text) to authenticated, service_role;

commit;
