-- deploy-peek: to_regclass('public.customer_payers') is not null and to_regprocedure('public.set_bank_line_payer(uuid,uuid,text,text,text,text,text,text)') is not null and to_regprocedure('public.save_customer_payer(uuid,uuid,text,text,text,text,text,text)') is not null and to_regprocedure('public.delete_customer_payer(uuid)') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'payer_relation')
-- deploy-key: r2025customerpayers
-- 20261027120512_r2025_customer_payers.sql
--
-- R-2025 (27 Oct 2026, Pardeep — staging line "NEFT CR-INDB0000006-SHREE NANDIK TECHNOLOGIES
-- PRIVATE LIMITED-ORBIT SOFTWARE-INDBH23101090759", ₹16,709): "the account the payment came
-- from and the company that owns the account are different — there should be a warning, and a
-- system to manage them: the client often pays from another account and sometimes gets a third
-- party to pay."
--
-- * customer_payers — a customer's KNOWN payers (their own other account / a group company / a
--   director / a third party), per company. Everyone in the company reads them (the Reconcile
--   sheet guesses from them); only an owner or accountant adds, edits or removes one by hand
--   (save_customer_payer / delete_customer_payer). Never written from the browser directly.
-- * bank_transactions.payer — the answer given on the Reconcile sheet BEFORE saving
--   (set_bank_line_payer): who paid, how they relate to the customer, for which customer.
-- * When that line is then reconciled to the customer's receipt (matched_to_type payment /
--   project — every save path, one transaction with it), a trigger writes payer_name +
--   payer_relation on the receipt (the voucher reads "Received from X on behalf of <customer>")
--   and learns the payer for that customer (customer_payers, uses + 1). A line booked to a
--   different customer than the answer named learns nothing.
-- * The GST invoice, the receipt's customer and every amount are untouched: the payer is a note.
-- Test: supabase/tests/r2025_customer_payers.test.sql
begin;

/* ── 1. The key — twin of payerKey() in src/lib/banking/customer-payer.ts ── */
create or replace function public.payer_name_key(p text)
returns text
language sql
immutable
set search_path = public
as $$
  select case when length(k) >= 3 then k end
    from (select btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z]+', ' ', 'g')) as k) s;
$$;
revoke all on function public.payer_name_key(text) from public, anon;
grant execute on function public.payer_name_key(text) to authenticated, service_role;

/* ── 2. Known payers ── */
create table if not exists public.customer_payers (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references public.tenants(id) on delete cascade,
  customer_id    uuid        not null references public.customers(id) on delete cascade,
  payer_name     text        not null check (length(btrim(payer_name)) between 3 and 200),
  payer_name_key text        not null check (length(payer_name_key) >= 3 and payer_name_key ~ '^[a-z]+( [a-z]+)*$'),
  ifsc           text        check (ifsc is null or length(ifsc) <= 20),
  upi_id         text        check (upi_id is null or length(upi_id) <= 100),
  account_tail   text        check (account_tail is null or account_tail ~ '^[0-9]{3,6}$'),
  relation       text        not null check (relation in ('own_account', 'group_company', 'director', 'third_party')),
  note           text        check (note is null or length(note) <= 500),
  first_seen_txn uuid        references public.bank_transactions(id) on delete set null,
  last_seen_txn  uuid        references public.bank_transactions(id) on delete set null,
  uses           integer     not null default 0,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, customer_id, payer_name_key)
);
comment on table public.customer_payers is
  'R-2025: a customer''s known payers (own other account / group company / director / third party). Learned when a bank line answered on the Reconcile sheet is reconciled (tg_bank_line_payer_learn), or added by an owner / accountant (save_customer_payer). Read by the Reconcile sheet''s customer guess.';
create index if not exists customer_payers_key_idx on public.customer_payers (tenant_id, payer_name_key);
create index if not exists customer_payers_customer_idx on public.customer_payers (customer_id);

alter table public.customer_payers enable row level security;
drop policy if exists "tenant isolation read" on public.customer_payers;
drop policy if exists zzz_service_role_all on public.customer_payers;
create policy "tenant isolation read" on public.customer_payers for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));
-- Cloud SQL has no BYPASSRLS: the service role needs its own policy.
create policy zzz_service_role_all on public.customer_payers as permissive for all to service_role
  using (true) with check (true);
revoke all on public.customer_payers from anon;
revoke insert, update, delete on public.customer_payers from authenticated;
grant select on public.customer_payers to authenticated;
grant select, insert, update, delete on public.customer_payers to service_role;

/* ── 3. The answer on the line, and the payer on the receipt ── */
alter table public.bank_transactions add column if not exists payer jsonb;
comment on column public.bank_transactions.payer is
  'R-2025: who paid this money-in line when it was not the customer — {name, key, relation, note, customer_id, ifsc, upi, account_tail}, set by set_bank_line_payer before the line is reconciled.';
alter table public.payments add column if not exists payer_name text;
alter table public.payments add column if not exists payer_relation text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_payer_relation_check') then
    alter table public.payments add constraint payments_payer_relation_check
      check (payer_relation is null or payer_relation in ('own_account', 'group_company', 'director', 'third_party'));
  end if;
end $$;
comment on column public.payments.payer_name is
  'R-2025: the account holder who actually paid, when not the customer (the receipt stays in the customer''s name).';

/* ── 4. set_bank_line_payer — the sheet's answer, before Save ── */
create or replace function public.set_bank_line_payer(
  p_txn_id uuid, p_customer_id uuid, p_payer_name text, p_relation text, p_note text,
  p_ifsc text, p_upi text, p_account_tail text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_key    text;
  v_payer  jsonb;
begin
  -- R-2025
  if v_tenant is null then
    raise exception 'Sign in to a company first.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank line.' using errcode = '42501';
  end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant for update;
  if not found then
    raise exception 'Bank line not found.' using errcode = 'P0002';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in line has a payer.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled. Un-reconcile it first.' using errcode = '22023';
  end if;

  if p_relation is null then
    update public.bank_transactions set payer = null where id = p_txn_id;
    return null;
  end if;
  if p_relation not in ('own_account', 'group_company', 'director', 'third_party') then
    raise exception 'Say how this payer is related to the customer.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id and tenant_id = v_tenant) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  v_key := public.payer_name_key(p_payer_name);
  if v_key is null or length(btrim(p_payer_name)) > 200 then
    raise exception 'The payer''s name is missing.' using errcode = '22023';
  end if;

  v_payer := jsonb_build_object(
    'name', btrim(regexp_replace(p_payer_name, '\s+', ' ', 'g')), 'key', v_key, 'relation', p_relation,
    'note', nullif(btrim(left(coalesce(p_note, ''), 500)), ''), 'customer_id', p_customer_id,
    'ifsc', nullif(upper(btrim(coalesce(p_ifsc, ''))), ''), 'upi', nullif(lower(btrim(coalesce(p_upi, ''))), ''),
    'account_tail', case when p_account_tail ~ '^[0-9]{3,6}$' then p_account_tail end);
  update public.bank_transactions set payer = v_payer where id = p_txn_id;
  return v_payer;
end;
$$;
revoke all on function public.set_bank_line_payer(uuid, uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.set_bank_line_payer(uuid, uuid, text, text, text, text, text, text) to authenticated, service_role;

/* ── 5. On reconcile: the receipt gets the payer, the customer learns it ── */
create or replace function public.tg_bank_line_payer_learn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cust uuid;
  v_n    integer := 0;
begin
  -- R-2025
  if new.payer is null or new.matched_to_type not in ('payment', 'project') or new.matched_to_id is null then
    return new;
  end if;
  v_cust := nullif(new.payer ->> 'customer_id', '')::uuid;
  if v_cust is null or new.payer ->> 'key' is null then return new; end if;

  update public.payments
     set payer_name = new.payer ->> 'name', payer_relation = new.payer ->> 'relation'
   where id::text = new.matched_to_id and tenant_id = new.tenant_id and customer_id = v_cust;
  get diagnostics v_n = row_count;
  /* Booked to a different customer than the answer named → the answer was not for this booking. */
  if v_n = 0 then return new; end if;

  insert into public.customer_payers as cp
    (tenant_id, customer_id, payer_name, payer_name_key, ifsc, upi_id, account_tail, relation, note,
     first_seen_txn, last_seen_txn, uses, created_by)
  values
    (new.tenant_id, v_cust, new.payer ->> 'name', new.payer ->> 'key', new.payer ->> 'ifsc', new.payer ->> 'upi',
     new.payer ->> 'account_tail', new.payer ->> 'relation', new.payer ->> 'note', new.id, new.id, 1, auth.uid())
  on conflict (tenant_id, customer_id, payer_name_key) do update
     set uses          = cp.uses + case when cp.last_seen_txn is distinct from excluded.last_seen_txn then 1 else 0 end,
         last_seen_txn = excluded.last_seen_txn,
         first_seen_txn = coalesce(cp.first_seen_txn, excluded.first_seen_txn),
         relation      = excluded.relation,
         note          = coalesce(excluded.note, cp.note),
         ifsc          = coalesce(cp.ifsc, excluded.ifsc),
         upi_id        = coalesce(cp.upi_id, excluded.upi_id),
         account_tail  = coalesce(cp.account_tail, excluded.account_tail),
         updated_at    = now();
  return new;
end;
$$;
revoke all on function public.tg_bank_line_payer_learn() from public, anon, authenticated;

drop trigger if exists trg_bank_line_payer_learn on public.bank_transactions;
create trigger trg_bank_line_payer_learn
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row
  when (new.payer is not null and new.matched_to_type is not null
        and (old.matched_to_type is null or old.matched_to_id is distinct from new.matched_to_id))
  execute function public.tg_bank_line_payer_learn();

/* ── 6. By hand on the customer page — owner / accountant ── */
create or replace function public.save_customer_payer(
  p_id uuid, p_customer_id uuid, p_payer_name text, p_relation text, p_note text,
  p_ifsc text, p_upi text, p_account_tail text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_key    text;
  v_id     uuid;
begin
  -- R-2025
  if v_tenant is null then
    raise exception 'Sign in to a company first.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant can change a customer''s known payers.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id and tenant_id = v_tenant) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  if p_relation is null or p_relation not in ('own_account', 'group_company', 'director', 'third_party') then
    raise exception 'Say how this payer is related to the customer.' using errcode = '22023';
  end if;
  v_key := public.payer_name_key(p_payer_name);
  if v_key is null or length(btrim(p_payer_name)) > 200 then
    raise exception 'The payer''s name is missing.' using errcode = '22023';
  end if;
  if p_account_tail is not null and btrim(p_account_tail) <> '' and p_account_tail !~ '^[0-9]{3,6}$' then
    raise exception 'Account ending: 3 to 6 digits.' using errcode = '22023';
  end if;
  if exists (select 1 from public.customer_payers where tenant_id = v_tenant and customer_id = p_customer_id
               and payer_name_key = v_key and id is distinct from p_id) then
    raise exception 'This payer is already in the customer''s known payers.' using errcode = '23505';
  end if;

  if p_id is null then
    insert into public.customer_payers (tenant_id, customer_id, payer_name, payer_name_key, ifsc, upi_id, account_tail,
                                        relation, note, uses, created_by)
    values (v_tenant, p_customer_id, btrim(regexp_replace(p_payer_name, '\s+', ' ', 'g')), v_key,
            nullif(upper(btrim(coalesce(p_ifsc, ''))), ''), nullif(lower(btrim(coalesce(p_upi, ''))), ''),
            nullif(btrim(coalesce(p_account_tail, '')), ''), p_relation, nullif(btrim(left(coalesce(p_note, ''), 500)), ''),
            0, auth.uid())
    returning id into v_id;
  else
    update public.customer_payers
       set payer_name = btrim(regexp_replace(p_payer_name, '\s+', ' ', 'g')), payer_name_key = v_key,
           ifsc = nullif(upper(btrim(coalesce(p_ifsc, ''))), ''), upi_id = nullif(lower(btrim(coalesce(p_upi, ''))), ''),
           account_tail = nullif(btrim(coalesce(p_account_tail, '')), ''), relation = p_relation,
           note = nullif(btrim(left(coalesce(p_note, ''), 500)), ''), updated_at = now()
     where id = p_id and tenant_id = v_tenant and customer_id = p_customer_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Known payer not found.' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.save_customer_payer(uuid, uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.save_customer_payer(uuid, uuid, text, text, text, text, text, text) to authenticated, service_role;

create or replace function public.delete_customer_payer(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  -- R-2025
  if v_tenant is null then
    raise exception 'Sign in to a company first.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant can change a customer''s known payers.' using errcode = '42501';
  end if;
  delete from public.customer_payers where id = p_id and tenant_id = v_tenant;
  if not found then
    raise exception 'Known payer not found.' using errcode = 'P0002';
  end if;
  return true;
end;
$$;
revoke all on function public.delete_customer_payer(uuid) from public, anon;
grant execute on function public.delete_customer_payer(uuid) to authenticated, service_role;

commit;
