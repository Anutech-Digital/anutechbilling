-- deploy-peek: to_regclass('public.firm_partners') is not null and to_regprocedure('public.save_firm_partner(uuid,text,text,text,boolean,numeric,integer,date,date,text)') is not null and to_regprocedure('public.delete_firm_partner(uuid)') is not null and to_regprocedure('public.link_owner_equity_partner(uuid,uuid)') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'owner_equity_movements' and column_name = 'partner_id')
-- deploy-key: r1847firmpartners
-- 20261024190000_r1847_firm_partners.sql
--
-- R-1847 (epic R-1841, Phase 2 — Partnership / LLP): the partners register.
--
-- A partnership firm or LLP had no list of its partners: R-1839's drawings / capital entries
-- carried the partner as free text. Every later step (per-partner capital R-1848, profit split
-- and s.40(b) R-1849, 194T TDS, LLP Form 11) needs one list. LLP = partnership with
-- is_designated + DPIN (R-1841 decision 1), so one table serves both.
--
-- ══ THE DATA ═══════════════════════════════════════════════════════════════════════════
--   firm_partners — one row per partner: name, PAN, DIN/DPIN (LLP), designated partner (LLP),
--   profit-sharing ratio %, capital contribution (₹, whole rupees, as per the deed / CA — the
--   partner's capital before entries recorded in the app), joined / left dates, note.
--   "Active" is not stored: a partner is active until left_on (one fact, one place).
--   Ratios that do not add up to 100 % are WARNED on the screen, never blocked (card R-1847).
--
--   owner_equity_movements.partner_id — nullable link to the register. Existing rows are NOT
--   changed by this migration: their free-text partner_name stays as it is and the screen
--   offers "Link to partner" (link_owner_equity_partner, which keeps the stored name).
--   New entries: the existing R-1839 functions still take the partner's name; a trigger links
--   it to the register partner of that name (case-insensitive). Once a firm has partners in
--   the register, a name that is not in it is refused — pick from the register.
--
-- Writes only through the functions (no direct insert/update/delete grants). §17c guard on
-- every function; roles owner, manager, accountant (same as R-1839's equity entries). Reads:
-- same company AND one of those roles. Proof: supabase/tests/r1847_firm_partners.test.sql.

begin;

-- ── 1. The register ──────────────────────────────────────────────────────────────────────
create table if not exists public.firm_partners (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references public.tenants(id) on delete cascade,
  name                  text          not null check (length(btrim(name)) between 1 and 200),
  pan                   text          check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  din_dpin              text          check (din_dpin is null or din_dpin ~ '^[0-9]{8}$'),
  is_designated         boolean       not null default false,
  profit_share_pct      numeric(5,2)  not null default 0 check (profit_share_pct between 0 and 100),
  capital_contribution  integer       not null default 0 check (capital_contribution >= 0),
  joined_on             date,
  left_on               date,
  note                  text          check (note is null or length(note) <= 1000),
  created_by            uuid,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),
  constraint firm_partners_left_after_joined check (left_on is null or joined_on is null or left_on >= joined_on)
);

comment on table public.firm_partners is
  'R-1847: partners of a partnership firm / LLP — PAN, DIN/DPIN, designated, profit share %, capital contribution, joined/left. Active = left_on is null.';

create unique index if not exists firm_partners_tenant_name_uq on public.firm_partners (tenant_id, lower(btrim(name)));
create unique index if not exists firm_partners_tenant_pan_uq  on public.firm_partners (tenant_id, pan) where pan is not null;

alter table public.firm_partners enable row level security;

drop policy if exists "tenant isolation read" on public.firm_partners;
drop policy if exists zzz_service_role_all on public.firm_partners;
create policy "tenant isolation read" on public.firm_partners for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'accountant')));
-- Cloud SQL has no BYPASSRLS: the service role needs its own policy.
create policy zzz_service_role_all on public.firm_partners as permissive for all to service_role
  using (true) with check (true);

revoke all on public.firm_partners from anon, authenticated;
grant select on public.firm_partners to authenticated;
grant select, insert, update, delete on public.firm_partners to service_role;

-- ── 2. Drawings / capital entries can point at a register partner ─────────────────────────
alter table public.owner_equity_movements
  add column if not exists partner_id uuid references public.firm_partners(id) on delete restrict;
create index if not exists owner_equity_movements_partner_idx
  on public.owner_equity_movements (partner_id) where partner_id is not null;

-- ── 3. Add / edit a partner ────────────────────────────────────────────────────────────────
create or replace function public.save_firm_partner(
  p_id                    uuid,
  p_name                  text,
  p_pan                   text,
  p_din_dpin              text,
  p_is_designated         boolean,
  p_profit_share_pct      numeric,
  p_capital_contribution  integer,
  p_joined_on             date,
  p_left_on               date,
  p_note                  text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_type     text;
  v_name     text := nullif(btrim(coalesce(p_name, '')), '');
  v_pan      text := nullif(upper(btrim(coalesce(p_pan, ''))), '');
  v_din      text := nullif(btrim(coalesce(p_din_dpin, '')), '');
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_pct      numeric := coalesce(p_profit_share_pct, 0);
  v_cap      integer := coalesce(p_capital_contribution, 0);
  v_row      public.firm_partners;
  v_last     date;
  v_id       uuid;
begin
  /* R-1847: §17c guard + money role (production/CLAUDE.md). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change the partners register' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type is null or v_type not in ('partnership', 'llp') then
    raise exception 'The partners register is for a Partnership or LLP — set the business type in Settings → Company first.';
  end if;

  if v_name is null then raise exception 'Enter the partner''s name.'; end if;
  if length(v_name) > 200 then raise exception 'The name is too long (200 characters at most).'; end if;
  if v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then
    raise exception 'PAN must be 10 characters like ABCDE1234F (5 letters, 4 digits, 1 letter).';
  end if;
  if v_din is not null and v_din !~ '^[0-9]{8}$' then
    raise exception 'DIN / DPIN must be 8 digits.';
  end if;
  if v_pct < 0 or v_pct > 100 then raise exception 'Profit share must be between 0 and 100 %%.'; end if;
  if v_cap < 0 then raise exception 'The capital contribution cannot be below ₹0.'; end if;
  if p_left_on is not null and p_joined_on is not null and p_left_on < p_joined_on then
    raise exception 'The leaving date cannot be before the joining date.';
  end if;
  if v_note is not null and length(v_note) > 1000 then raise exception 'The note is too long (1000 characters at most).'; end if;

  if exists (select 1 from public.firm_partners
              where tenant_id = v_tenant and lower(btrim(name)) = lower(v_name)
                and id is distinct from p_id) then
    raise exception '% is already in the partners register.', v_name;
  end if;
  if v_pan is not null and exists (select 1 from public.firm_partners
              where tenant_id = v_tenant and pan = v_pan and id is distinct from p_id) then
    raise exception 'PAN % is already used by another partner.', v_pan;
  end if;

  if p_id is null then
    insert into public.firm_partners
      (tenant_id, name, pan, din_dpin, is_designated, profit_share_pct, capital_contribution,
       joined_on, left_on, note, created_by)
    values
      (v_tenant, v_name, v_pan, v_din, coalesce(p_is_designated, false), v_pct, v_cap,
       p_joined_on, p_left_on, v_note, auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  select * into v_row from public.firm_partners where id = p_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That partner is not in your company.'; end if;
  if p_left_on is not null then
    select max(movement_date) into v_last from public.owner_equity_movements
     where tenant_id = v_tenant and partner_id = p_id;
    if v_last is not null and v_last > p_left_on then
      raise exception '% has entries after % (last one on %) — pick a leaving date on or after it.',
        v_name, to_char(p_left_on, 'DD Mon YYYY'), to_char(v_last, 'DD Mon YYYY');
    end if;
  end if;
  update public.firm_partners
     set name = v_name, pan = v_pan, din_dpin = v_din, is_designated = coalesce(p_is_designated, false),
         profit_share_pct = v_pct, capital_contribution = v_cap, joined_on = p_joined_on,
         left_on = p_left_on, note = v_note, updated_at = now()
   where id = p_id;
  return p_id;
end;
$$;

revoke all on function public.save_firm_partner(uuid, text, text, text, boolean, numeric, integer, date, date, text) from public, anon;
grant execute on function public.save_firm_partner(uuid, text, text, text, boolean, numeric, integer, date, date, text) to authenticated, service_role;

-- ── 4. Delete a partner added by mistake ───────────────────────────────────────────────────
create or replace function public.delete_firm_partner(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_row      public.firm_partners;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change the partners register' using errcode = '42501';
  end if;
  select * into v_row from public.firm_partners where id = p_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That partner is not in your company.'; end if;
  if exists (select 1 from public.owner_equity_movements where partner_id = p_id) then
    raise exception '% has drawings or capital entries — set a leaving date instead of deleting.', v_row.name;
  end if;
  delete from public.firm_partners where id = p_id;
end;
$$;

revoke all on function public.delete_firm_partner(uuid) from public, anon;
grant execute on function public.delete_firm_partner(uuid) to authenticated, service_role;

-- ── 5. Link an older free-text entry to a register partner (stored name kept) ─────────────
create or replace function public.link_owner_equity_partner(p_movement_id uuid, p_partner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_mov      public.owner_equity_movements;
  v_p        public.firm_partners;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can link an entry to a partner' using errcode = '42501';
  end if;
  select * into v_mov from public.owner_equity_movements where id = p_movement_id and tenant_id = v_tenant for update;
  if not found then raise exception 'That drawings / capital entry is not in your company.'; end if;
  select * into v_p from public.firm_partners where id = p_partner_id and tenant_id = v_tenant;
  if not found then raise exception 'That partner is not in your company.'; end if;
  update public.owner_equity_movements set partner_id = p_partner_id where id = p_movement_id;
end;
$$;

revoke all on function public.link_owner_equity_partner(uuid, uuid) from public, anon;
grant execute on function public.link_owner_equity_partner(uuid, uuid) to authenticated, service_role;

-- ── 6. New entries link to the register by name ────────────────────────────────────────────
--   R-1839's record_owner_equity_movement / book_bank_txn_as_owner_equity keep their
--   signatures (and deploy-peeks); the screen passes the register partner's exact name.
--   INSERT, or an UPDATE that changes the name: the name is looked up in the register.
--   An UPDATE that leaves name and partner as they were changes nothing here — old free-text
--   rows are never linked behind the user's back.
create or replace function public.tg_owner_equity_partner_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type  text;
  v_p     public.firm_partners;
begin
  if tg_op = 'UPDATE'
     and new.partner_name is not distinct from old.partner_name
     and new.partner_id is not distinct from old.partner_id then
    return new;
  end if;

  if new.partner_id is not null then
    select * into v_p from public.firm_partners where id = new.partner_id;
    if not found or v_p.tenant_id <> new.tenant_id then
      raise exception 'That partner is not in your company.';
    end if;
  elsif new.partner_name is not null then
    select business_type into v_type from public.tenants where id = new.tenant_id;
    if v_type in ('partnership', 'llp')
       and exists (select 1 from public.firm_partners where tenant_id = new.tenant_id) then
      select * into v_p from public.firm_partners
       where tenant_id = new.tenant_id and lower(btrim(name)) = lower(btrim(new.partner_name));
      if not found then
        raise exception '% is not in the partners register — pick a partner from the list (Settings → Company → Partners).', new.partner_name;
      end if;
      new.partner_id := v_p.id;
    end if;
  end if;

  if v_p.id is not null and v_p.left_on is not null and new.movement_date > v_p.left_on then
    raise exception '% left the firm on % — this entry is dated %.',
      v_p.name, to_char(v_p.left_on, 'DD Mon YYYY'), to_char(new.movement_date, 'DD Mon YYYY');
  end if;
  return new;
end;
$$;

revoke all on function public.tg_owner_equity_partner_link() from public, anon;

drop trigger if exists trg_owner_equity_partner_link on public.owner_equity_movements;
create trigger trg_owner_equity_partner_link
  before insert or update of partner_name, partner_id on public.owner_equity_movements
  for each row execute function public.tg_owner_equity_partner_link();

commit;
