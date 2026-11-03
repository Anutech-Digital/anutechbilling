-- deploy-peek: (to_regclass('public.personal_owe_hold') is not null and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'personal_owe_hold' and policyname = 'personal_owe_hold_service_role'))
-- deploy-key: r2386personalowehold
-- R-2386 (goal G-PERSONAL, 2 Nov 2026): Private Vault → "Money I owe / hold for others".
--
-- Why: Pardeep received a ₹5 lakh advance (byana) for his daughter's property sale and keeps
-- it as cash with his brother. Banking can hold the cash as an asset, but there was no place
-- for the other side — the money is owed to the buyer (until the sale) or belongs to the
-- daughter — so Net worth was ₹5 lakh too high.
--
-- What this adds
--   * personal_owe_hold — one row per sum the person holds but does not own:
--       kind 'advance_received'  an advance / byana received for a sale
--       kind 'held_for_other'    money held on behalf of someone (e.g. a child)
--     party, occurred_on, amount (whole rupees, > 0), note, optional account_id (where the
--     cash sits — owner-safe composite FK like GP-12a), status open/settled.
--     Settling records how: 'refunded' (advance paid back), 'handed_over' (held money given
--     to its owner) or 'converted_to_sale' (the advance became part of the sale price — only
--     for an advance; no capital-gains maths here).
--   * Loans taken / given are NOT here: they get their own card (R-2388, EMI, interest). The
--     Overview adds them to the same "owed" total through lib/vault/personal/owe-hold.ts.
--
-- Net worth (Overview, lib/vault/personal/net-worth.ts) = assets − OPEN amounts here − card
-- dues. A settled row no longer counts.
--
-- The privacy rule is the one from 20260819170000_owner_personal_vault.sql, unchanged:
--     owner_user_id = auth.uid()  AND  tenant_id = current_tenant_id()
-- plus the R-450 service_role policy (Cloud SQL has no BYPASSRLS).

begin;

create table if not exists public.personal_owe_hold (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  kind          text not null check (kind in ('advance_received', 'held_for_other')),
  party         text not null check (length(btrim(party)) between 1 and 120),
  occurred_on   date not null default current_date,
  amount        bigint not null check (amount > 0 and amount <= 1000000000000),
  note          text check (note is null or length(note) <= 500),
  account_id    uuid,
  status        text not null default 'open' check (status in ('open', 'settled')),
  settled_on    date,
  settled_how   text check (settled_how is null or settled_how in ('refunded', 'handed_over', 'converted_to_sale')),
  settle_note   text check (settle_note is null or length(settle_note) <= 500),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Open = no settlement facts; settled = both the date and the way are known.
  constraint personal_owe_hold_settled_check check (
    (status = 'open' and settled_on is null and settled_how is null)
    or (status = 'settled' and settled_on is not null and settled_how is not null)),
  -- Only an advance can turn into a sale price.
  constraint personal_owe_hold_convert_check check (
    settled_how is distinct from 'converted_to_sale' or kind = 'advance_received'),
  -- Owner-safe: the linked account must belong to the same person (a service-role job runs
  -- without RLS, so the database itself refuses "my entry on your account").
  constraint personal_owe_hold_account_owner_fkey
    foreign key (account_id, owner_user_id)
    references public.personal_accounts (id, owner_user_id)
    on delete set null (account_id)
);

comment on table public.personal_owe_hold is
  'R-2386: money the person holds but does not own — an advance (byana) received for a sale, or money held on behalf of someone. Open rows are subtracted from Private Vault net worth. Private to owner_user_id; loans are R-2388.';
comment on column public.personal_owe_hold.account_id is
  'Where the cash sits (a personal account of the same owner). Informational: the account balance is not changed by this row.';
comment on column public.personal_owe_hold.settled_how is
  'refunded = advance paid back; handed_over = held money given to its owner; converted_to_sale = the advance became part of the sale price (advance only).';

create index if not exists personal_owe_hold_owner_idx
  on public.personal_owe_hold (owner_user_id, status, occurred_on desc);

create index if not exists personal_owe_hold_account_idx
  on public.personal_owe_hold (account_id, owner_user_id)
  where account_id is not null;

alter table public.personal_owe_hold enable row level security;

drop policy if exists personal_owe_hold_all on public.personal_owe_hold;
create policy personal_owe_hold_all on public.personal_owe_hold
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

-- R-450: Cloud SQL has no BYPASSRLS; a server job (DPDP export/delete) needs its own policy.
-- It names service_role only — browsers never get it.
drop policy if exists personal_owe_hold_service_role on public.personal_owe_hold;
create policy personal_owe_hold_service_role on public.personal_owe_hold
  for all to service_role using (true) with check (true);

revoke all on public.personal_owe_hold from anon, public;
grant select, insert, update, delete on public.personal_owe_hold to authenticated;
grant all on public.personal_owe_hold to service_role;

commit;
