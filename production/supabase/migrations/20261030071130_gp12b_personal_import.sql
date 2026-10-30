-- deploy-peek: (to_regprocedure('public.personal_import_commit(jsonb)') is not null and to_regclass('public.personal_category_rules') is not null)
-- deploy-key: gp12bpersonalimport
-- R-2128 (GP-12b, goal G-PERSONAL, 30 Oct 2026): statement-import tables for the personal money ledger.
--
-- What this adds
--   * personal_import_batches  — one row per uploaded statement (which account, which file,
--                                how many lines were new / already there).
--   * personal_categories      — the person's OWN extra categories. The default list lives in
--                                code (lib/vault/personal, GP-11); which defaults ship is an
--                                open owner decision, so nothing is seeded here.
--   * personal_category_rules  — "always put X under Y", private to the person who made it.
--   * personal_import_commit(batch jsonb) — SECURITY INVOKER: saves the batch row and its
--     statement lines in ONE call, skipping lines already imported (dedupe_hash, the
--     unique key from GP-12a), and returns {batch_id, inserted, skipped, rows}.
--
-- The privacy rule is the one from 20260819170000_owner_personal_vault.sql, unchanged:
--     owner_user_id = auth.uid()  AND  tenant_id = current_tenant_id()
-- No policy mentions a role and none is tenant-wide: a co-owner or a staff member in the
-- same tenant reads ZERO rows of somebody's import history or category rules (a rule like
-- "clinic -> Health" says something private on its own).
--
-- Why SECURITY INVOKER: the caller's own RLS decides everything — the account must be one
-- the caller can see, every inserted row must pass the owner policy. A definer function
-- here would be a second, weaker copy of the policy.
--
-- GP-10 (personal gateway allowlist) has not landed yet; its ratchet scans for
-- `function public.personal_*`, so it seeds personal_import_commit itself.

begin;

-- ─── 1. import batches ─────────────────────────────────────────────────────
create table if not exists public.personal_import_batches (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  owner_user_id  uuid not null references public.users(id) on delete cascade,
  account_id     uuid,
  file_name      text check (file_name is null or length(file_name) <= 255),
  file_kind      text check (file_kind is null or file_kind in ('csv', 'xlsx', 'other')),
  statement_from date,
  statement_to   date,
  row_count      integer not null default 0 check (row_count >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  skipped_count  integer not null default 0 check (skipped_count >= 0),
  created_at     timestamptz not null default now(),
  constraint personal_import_batches_id_owner_key unique (id, owner_user_id),
  constraint personal_import_batches_period_check
    check (statement_from is null or statement_to is null or statement_from <= statement_to),
  -- Owner-safe like GP-12a: a batch can only name an account of the same person.
  constraint personal_import_batches_account_owner_fkey
    foreign key (account_id, owner_user_id)
    references public.personal_accounts (id, owner_user_id)
    on delete set null (account_id)
);

comment on table public.personal_import_batches is
  'R-2128: one uploaded bank/card statement. inserted_count = new lines saved, skipped_count = lines already imported earlier (same dedupe_hash). Private to owner_user_id.';

create index if not exists personal_import_batches_owner_idx
  on public.personal_import_batches (owner_user_id, created_at desc);

-- personal_transactions.import_batch_id (added by GP-12a) now points at a real batch of the
-- SAME owner. Deleting a batch keeps the money rows (they are real spending); it only
-- forgets which upload they came from.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'personal_transactions_import_batch_fkey') then
    alter table public.personal_transactions
      add constraint personal_transactions_import_batch_fkey
      foreign key (import_batch_id, owner_user_id)
      references public.personal_import_batches (id, owner_user_id)
      on delete set null (import_batch_id);
  end if;
end $$;

create index if not exists personal_transactions_import_batch_idx
  on public.personal_transactions (import_batch_id)
  where import_batch_id is not null;

-- ─── 2. the person's own categories ────────────────────────────────────────
create table if not exists public.personal_categories (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 60),
  direction     text not null default 'expense' check (direction in ('expense', 'income')),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.personal_categories is
  'R-2128: categories a person added on top of the built-in list (which lives in code). Private to owner_user_id. personal_transactions.category stays text, so deleting a category never rewrites past rows.';

create unique index if not exists personal_categories_owner_name_uq
  on public.personal_categories (owner_user_id, direction, lower(btrim(name)));

-- ─── 3. private auto-category rules ────────────────────────────────────────
create table if not exists public.personal_category_rules (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  match_text    text not null check (length(btrim(match_text)) between 2 and 100),
  category      text not null check (length(btrim(category)) between 1 and 60),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.personal_category_rules is
  'R-2128: "always put <match_text> under <category>" — a statement line whose description contains match_text (case-insensitive) gets that category. Private to owner_user_id: never tenant-wide, a team member sees none.';

-- One rule per text per person — two rules for "zomato" would make the winner a guess.
create unique index if not exists personal_category_rules_owner_text_uq
  on public.personal_category_rules (owner_user_id, lower(btrim(match_text)));

-- ─── 4. RLS: the owner_personal_vault shape, word for word ─────────────────
alter table public.personal_import_batches enable row level security;
alter table public.personal_categories     enable row level security;
alter table public.personal_category_rules enable row level security;

drop policy if exists personal_import_batches_all on public.personal_import_batches;
create policy personal_import_batches_all on public.personal_import_batches
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

drop policy if exists personal_categories_all on public.personal_categories;
create policy personal_categories_all on public.personal_categories
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

drop policy if exists personal_category_rules_all on public.personal_category_rules;
create policy personal_category_rules_all on public.personal_category_rules
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

revoke all on public.personal_import_batches, public.personal_categories, public.personal_category_rules from anon, public;
grant select, insert, update, delete on public.personal_import_batches, public.personal_categories, public.personal_category_rules to authenticated;
grant all on public.personal_import_batches, public.personal_categories, public.personal_category_rules to service_role;

-- ─── 5. personal_import_commit ─────────────────────────────────────────────
-- batch = {
--   account_id, file_name?, file_kind?, statement_from?, statement_to?,
--   rows: [{kind, amount (whole rupees, > 0), occurred_on, dedupe_hash,
--           category?, note?, reference?, raw_description?, balance_after?}]
-- }
-- Owner and tenant come from the session; any owner_user_id / tenant_id in the payload is ignored.
-- One bad line refuses the whole batch (it is one statement — half of it is a wrong balance).
create or replace function public.personal_import_commit(batch jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_tenant   uuid;
  v_account  uuid;
  v_rows     jsonb := batch -> 'rows';
  v_n        integer;
  v_bad      record;
  v_batch_id uuid;
  v_inserted integer;
begin
  if v_uid is null then
    raise exception 'You are not signed in — please sign in again.' using errcode = '42501';
  end if;
  v_tenant := current_tenant_id();
  if v_tenant is null then
    raise exception 'Your workspace is still loading — try again.' using errcode = '42501';
  end if;

  if v_rows is null or jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
    raise exception 'The statement has no lines to import.' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(v_rows);
  if v_n > 5000 then
    raise exception 'A statement can have at most 5,000 lines (this one has %). Split it by month.', v_n
      using errcode = '22023';
  end if;

  begin
    v_account := nullif(batch ->> 'account_id', '')::uuid;
  exception when invalid_text_representation then
    v_account := null;
  end;
  -- Under the caller's RLS: someone else's account simply is not found.
  if v_account is null
     or not exists (select 1 from public.personal_accounts where id = v_account and owner_user_id = v_uid) then
    raise exception 'Pick one of your accounts for this statement.' using errcode = '42501';
  end if;

  -- Check every line before writing anything, and name the first bad one.
  select ord, r into v_bad
    from jsonb_array_elements(v_rows) with ordinality as e(r, ord)
   where coalesce(btrim(r ->> 'dedupe_hash'), '') = ''
      or case when coalesce(r ->> 'amount', '') ~ '^[0-9]{1,15}$'
              then (r ->> 'amount')::bigint <= 0
              else true end
      or coalesce(r ->> 'occurred_on', '') !~ '^\d{4}-\d{2}-\d{2}$'
      or coalesce(r ->> 'kind', '') = ''
   order by ord
   limit 1;
  if found then
    raise exception 'Line % of the statement cannot be imported: it needs a date (YYYY-MM-DD), a kind, a whole-rupee amount above 0 and a dedupe key.', v_bad.ord
      using errcode = '22023';
  end if;

  insert into public.personal_import_batches
    (tenant_id, owner_user_id, account_id, file_name, file_kind, statement_from, statement_to, row_count)
  values
    (v_tenant, v_uid, v_account,
     nullif(btrim(batch ->> 'file_name'), ''),
     nullif(batch ->> 'file_kind', ''),
     nullif(batch ->> 'statement_from', '')::date,
     nullif(batch ->> 'statement_to', '')::date,
     v_n)
  returning id into v_batch_id;

  insert into public.personal_transactions
    (tenant_id, owner_user_id, account_id, kind, amount, occurred_on, category, note,
     source, import_batch_id, reference, raw_description, balance_after, dedupe_hash)
  select v_tenant, v_uid, v_account,
         r ->> 'kind',
         (r ->> 'amount')::bigint,
         (r ->> 'occurred_on')::date,
         nullif(btrim(r ->> 'category'), ''),
         nullif(btrim(r ->> 'note'), ''),
         'import', v_batch_id,
         nullif(btrim(r ->> 'reference'), ''),
         nullif(r ->> 'raw_description', ''),
         nullif(r ->> 'balance_after', '')::bigint,
         btrim(r ->> 'dedupe_hash')
    from jsonb_array_elements(v_rows) with ordinality as e(r, ord)
   order by ord
  on conflict (owner_user_id, account_id, dedupe_hash) where dedupe_hash is not null do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- Every line was already imported: no empty upload in the history.
    delete from public.personal_import_batches where id = v_batch_id;
    v_batch_id := null;
  else
    update public.personal_import_batches
       set inserted_count = v_inserted, skipped_count = v_n - v_inserted
     where id = v_batch_id;
  end if;

  return jsonb_build_object('batch_id', v_batch_id, 'inserted', v_inserted, 'skipped', v_n - v_inserted, 'rows', v_n);
end;
$$;

comment on function public.personal_import_commit(jsonb) is
  'R-2128: save one bank/card statement (batch row + lines) atomically for the signed-in person; lines whose dedupe_hash is already in that account are skipped. SECURITY INVOKER — the caller''s owner RLS applies. Returns {batch_id (null when nothing was new), inserted, skipped, rows}.';

revoke all on function public.personal_import_commit(jsonb) from public, anon;
grant execute on function public.personal_import_commit(jsonb) to authenticated, service_role;

commit;
