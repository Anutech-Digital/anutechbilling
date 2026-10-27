-- deploy-peek: to_regclass('public.partner_appropriations') is not null and to_regclass('public.partner_appropriation_lines') is not null and to_regprocedure('public.post_partner_appropriation(integer,bigint,jsonb)') is not null and to_regprocedure('public.undo_partner_appropriation(integer)') is not null and to_regprocedure('public.partner_remuneration_limit(integer,bigint)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.report_balance_sheet(date)') and prosrc like '%R-1849%')
-- deploy-key: r1849partnerappropriation
-- 20261025030249_r1849_partner_appropriation.sql
--
-- R-1849 (epic R-1841, Phase 2 — Partnership / LLP): the year-end split of the firm's profit
-- among its partners (P&L appropriation) — interest on capital, remuneration to working
-- partners, the rest by the profit-sharing ratio — and TDS on the partner's interest +
-- remuneration (s.194T / s.393(3) Table Sl. 7).
--
-- ══ THE DATA ═══════════════════════════════════════════════════════════════════════════
--   partner_appropriations       — one row per company per FY (unique = the FY lock: one split
--                                   per year). posted_on = 31 March of that FY.
--   partner_appropriation_lines  — one row per partner: capital base, deed vs allowed interest %,
--                                   interest, deed vs allowed remuneration, share of profit, TDS.
--   The screen (lib/accounting/partner-appropriation.ts) works the figures out; this function
--   CHECKS them against the law before saving (a browser cannot be trusted with money):
--     • interest % ≤ the deed's and ≤ 12 (s.40(b)(iv) 1961 / s.35(e)(iv) 2025);
--     • remuneration only to working partners, ≤ the deed's, all together ≤
--       partner_remuneration_limit(FY, book profit) (s.40(b)(v) / s.35(e)(iii));
--     • interest + remuneration + shares = the net profit sent, each share = the ratio;
--     • TDS = partner_tds_due(FY, interest + remuneration) (10% above ₹20,000 from 1 Apr 2025).
--   The legal figures sit in two places on purpose — TS for the preview, SQL as the guard — and
--   the same cases are tested on both sides (partner-appropriation.test.ts; the SQL test below).
--   Sources: incometaxindia.gov.in/w/section-35-181, /w/section-393-5, /w/section-40;
--   indiabudget.gov.in/budget2024-25/doc/memo.pdf (Finance (No. 2) Bill 2024).
--
-- Posting is ONE call (post_partner_appropriation) and so is undoing it
-- (undo_partner_appropriation) — atomic, reversible. §17c guard + money roles (owner, manager,
-- accountant) on both. Only a Partnership / LLP, only after the year is over, only once a year,
-- never inside locked books (trg_books_lock on posted_on), undo only the latest year posted.
--
-- Balance Sheet: the partner TDS is owed to the government from the day it is credited —
-- report_balance_sheet.dues_vendor_tds adds it (same as R-1891 otherwise).
-- Proof: supabase/tests/r1849_partner_appropriation.test.sql.

begin;

-- ── 1. Tables ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.partner_appropriations (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  fy_start            integer     not null check (fy_start between 2000 and 2100),
  posted_on           date        not null,
  net_profit          bigint      not null,
  interest_total      bigint      not null check (interest_total >= 0),
  book_profit         bigint      not null,
  max_remuneration    bigint      not null check (max_remuneration >= 0),
  remuneration_total  bigint      not null check (remuneration_total >= 0),
  residual            bigint      not null,
  tds_total           bigint      not null check (tds_total >= 0),
  created_by          uuid,
  created_at          timestamptz not null default now(),
  constraint partner_appropriations_fy_uq unique (tenant_id, fy_start),
  constraint partner_appropriations_posted_on_fy check (posted_on = make_date(fy_start + 1, 3, 31))
);
comment on table public.partner_appropriations is
  'R-1849: year-end split of a firm''s profit among partners — one row per company per FY (the FY lock). Lines in partner_appropriation_lines.';

create table if not exists public.partner_appropriation_lines (
  id                  uuid          primary key default gen_random_uuid(),
  tenant_id           uuid          not null references public.tenants(id) on delete cascade,
  appropriation_id    uuid          not null references public.partner_appropriations(id) on delete cascade,
  partner_id          uuid          not null references public.firm_partners(id) on delete restrict,
  share_pct           numeric(5,2)  not null check (share_pct between 0 and 100),
  capital_base        bigint        not null check (capital_base >= 0),
  interest_days       integer       not null check (interest_days between 0 and 366),
  deed_interest_pct   numeric(6,2)  not null check (deed_interest_pct >= 0),
  interest_pct        numeric(5,2)  not null check (interest_pct between 0 and 12),
  interest            bigint        not null check (interest >= 0),
  working             boolean       not null,
  deed_remuneration   bigint        not null check (deed_remuneration >= 0),
  remuneration        bigint        not null check (remuneration >= 0 and remuneration <= deed_remuneration),
  profit_share        bigint        not null,
  tds                 bigint        not null check (tds >= 0),
  tds_section         text,
  constraint partner_appropriation_lines_uq unique (appropriation_id, partner_id),
  constraint partner_appropriation_lines_working check (working or remuneration = 0),
  constraint partner_appropriation_lines_tds_section check (tds = 0 or tds_section is not null)
);
create index if not exists partner_appropriation_lines_partner_idx on public.partner_appropriation_lines (partner_id);
create index if not exists partner_appropriation_lines_tenant_idx on public.partner_appropriation_lines (tenant_id);
comment on table public.partner_appropriation_lines is
  'R-1849: one partner''s part of a year-end split — interest on capital, remuneration, share of profit, TDS (194T / 393(3)).';

alter table public.partner_appropriations enable row level security;
alter table public.partner_appropriation_lines enable row level security;

drop policy if exists "tenant isolation read" on public.partner_appropriations;
drop policy if exists zzz_service_role_all on public.partner_appropriations;
create policy "tenant isolation read" on public.partner_appropriations for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'accountant')));
create policy zzz_service_role_all on public.partner_appropriations as permissive for all to service_role
  using (true) with check (true);

drop policy if exists "tenant isolation read" on public.partner_appropriation_lines;
drop policy if exists zzz_service_role_all on public.partner_appropriation_lines;
create policy "tenant isolation read" on public.partner_appropriation_lines for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'accountant')));
create policy zzz_service_role_all on public.partner_appropriation_lines as permissive for all to service_role
  using (true) with check (true);

revoke all on public.partner_appropriations from anon, authenticated;
revoke all on public.partner_appropriation_lines from anon, authenticated;
grant select on public.partner_appropriations to authenticated;
grant select on public.partner_appropriation_lines to authenticated;
grant select, insert, update, delete on public.partner_appropriations to service_role;
grant select, insert, update, delete on public.partner_appropriation_lines to service_role;

-- Locked books: no split posted or undone inside them.
drop trigger if exists trg_books_lock on public.partner_appropriations;
create trigger trg_books_lock before insert or update or delete on public.partner_appropriations
  for each row execute function public.tg_books_locked('posted_on');

-- ── 2. The legal limits (mirror of lib/accounting/partner-appropriation.ts) ──────────────
--   fy_start 2026+: Income-tax Act 2025 s.35(e)(iii); 2024–2025: s.40(b)(v) as amended by the
--   Finance (No. 2) Act 2024 (AY 2025-26 on); earlier: the AY 2010-11 slab.
create or replace function public.partner_remuneration_limit(p_fy_start integer, p_book_profit bigint)
returns bigint
language sql
immutable
set search_path = public
as $$
  select case
    when p_book_profit <= 0 then case when p_fy_start >= 2024 then 300000 else 150000 end
    else round(
      greatest(case when p_fy_start >= 2024 then 300000 else 150000 end,
               least(p_book_profit, case when p_fy_start >= 2024 then 600000 else 300000 end) * 90 / 100.0)
      + greatest(0, p_book_profit - case when p_fy_start >= 2024 then 600000 else 300000 end) * 60 / 100.0)::bigint
  end
$$;
grant execute on function public.partner_remuneration_limit(integer, bigint) to authenticated, service_role;

--   s.194T (from 1 Apr 2025) / s.393(3) Table Sl. 7 (from 1 Apr 2026): 10% of the whole amount
--   once the year's interest + remuneration to the partner is above ₹20,000.
create or replace function public.partner_tds_due(p_fy_start integer, p_amount bigint)
returns bigint
language sql
immutable
set search_path = public
as $$
  select case when p_fy_start < 2025 or p_amount <= 20000 then 0
              else round(p_amount * 10 / 100.0)::bigint end
$$;
grant execute on function public.partner_tds_due(integer, bigint) to authenticated, service_role;

-- ── 3. Post the year's split ──────────────────────────────────────────────────────────────
--   p_lines: [{partner_id, capital_base, interest_days, deed_interest_pct, interest_pct, interest,
--              working, deed_remuneration, remuneration, profit_share, tds}]
create or replace function public.post_partner_appropriation(p_fy_start integer, p_net_profit bigint, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted   boolean;
  v_tenant    uuid := public.current_tenant_id();
  v_type      text;
  v_start     date;
  v_end       date;
  v_today     date := (now() at time zone 'Asia/Kolkata')::date;
  v_fy_days   integer;
  v_line      jsonb;
  v_p         public.firm_partners;
  v_ids       uuid[] := '{}';
  v_int_tot   bigint := 0;
  v_rem_tot   bigint := 0;
  v_share_tot bigint := 0;
  v_tds_tot   bigint := 0;
  v_book      bigint;
  v_max       bigint;
  v_residual  bigint;
  v_pct_tot   numeric := 0;
  v_sharers   integer := 0;
  v_in_year   integer;
  v_id        uuid;
  v_cap       bigint; v_days int; v_dpct numeric; v_ipct numeric; v_int bigint; v_work boolean;
  v_drem      bigint; v_rem bigint; v_share bigint; v_tds bigint; v_from date; v_to date; v_want bigint;
  v_section   text;
begin
  /* R-1849: §17c guard + money role (production/CLAUDE.md). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can split the profit among partners' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type is null or v_type not in ('partnership', 'llp') then
    raise exception 'The profit split is for a Partnership or LLP — set the business type in Settings → Company first.';
  end if;
  if p_fy_start is null or p_fy_start < 2000 or p_fy_start > 2100 then
    raise exception 'Pick the financial year.';
  end if;
  v_start := make_date(p_fy_start, 4, 1);
  v_end := make_date(p_fy_start + 1, 3, 31);
  v_fy_days := (v_end - v_start) + 1;
  if v_today <= v_end then
    raise exception 'FY %-% is not over yet — the profit can be split after %.',
      p_fy_start, lpad(((p_fy_start + 1) % 100)::text, 2, '0'), to_char(v_end, 'DD Mon YYYY');
  end if;
  if p_net_profit is null then raise exception 'The year''s profit is missing.'; end if;
  if exists (select 1 from public.partner_appropriations where tenant_id = v_tenant and fy_start = p_fy_start) then
    raise exception 'The profit for FY %-% is already split — undo it first to post it again.',
      p_fy_start, lpad(((p_fy_start + 1) % 100)::text, 2, '0');
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add the partners in the partners register first.';
  end if;

  select count(*) into v_in_year from public.firm_partners
   where tenant_id = v_tenant and (joined_on is null or joined_on <= v_end) and (left_on is null or left_on >= v_start);
  if v_in_year <> jsonb_array_length(p_lines) then
    raise exception 'Every partner in the firm during the year must be in the split (% in the register, % sent).',
      v_in_year, jsonb_array_length(p_lines);
  end if;

  -- First pass: each line on its own.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_p from public.firm_partners
     where id = (v_line->>'partner_id')::uuid and tenant_id = v_tenant;
    if not found then raise exception 'That partner is not in your company.'; end if;
    if v_p.id = any(v_ids) then raise exception '% is in the split twice.', v_p.name; end if;
    v_ids := v_ids || v_p.id;
    if (v_p.joined_on is not null and v_p.joined_on > v_end) or (v_p.left_on is not null and v_p.left_on < v_start) then
      raise exception '% was not a partner during FY %-%.', v_p.name, p_fy_start, lpad(((p_fy_start + 1) % 100)::text, 2, '0');
    end if;

    v_cap  := coalesce((v_line->>'capital_base')::bigint, 0);
    v_days := coalesce((v_line->>'interest_days')::int, 0);
    v_dpct := coalesce((v_line->>'deed_interest_pct')::numeric, 0);
    v_ipct := coalesce((v_line->>'interest_pct')::numeric, 0);
    v_int  := coalesce((v_line->>'interest')::bigint, 0);
    v_work := coalesce((v_line->>'working')::boolean, false);
    v_drem := coalesce((v_line->>'deed_remuneration')::bigint, 0);
    v_rem  := coalesce((v_line->>'remuneration')::bigint, 0);
    v_tds  := coalesce((v_line->>'tds')::bigint, 0);

    v_from := greatest(v_start, coalesce(v_p.joined_on, v_start));
    v_to := least(v_end, coalesce(v_p.left_on, v_end));
    if v_cap < 0 then raise exception '%: the capital for interest cannot be below ₹0.', v_p.name; end if;
    if v_days <> (v_to - v_from) + 1 then
      raise exception '%: interest days must be % (in the firm % to %).', v_p.name, (v_to - v_from) + 1,
        to_char(v_from, 'DD Mon YYYY'), to_char(v_to, 'DD Mon YYYY');
    end if;
    if v_ipct > 12 then raise exception '%: interest above 12%% a year is not allowed.', v_p.name; end if;
    if v_ipct > v_dpct or v_ipct < 0 then raise exception '%: interest cannot be more than the deed''s %.', v_p.name, v_dpct || '%'; end if;
    if v_int <> round(v_cap * v_ipct * v_days / (100.0 * v_fy_days)) then
      raise exception '%: interest at % on ₹% for % days is ₹%, not ₹%.', v_p.name, v_ipct || '%', v_cap, v_days,
        round(v_cap * v_ipct * v_days / (100.0 * v_fy_days)), v_int;
    end if;
    if v_rem < 0 or v_rem > v_drem then raise exception '%: remuneration cannot be more than the deed''s ₹%.', v_p.name, v_drem; end if;
    if not v_work and v_rem > 0 then raise exception '% is not a working partner — no remuneration is allowed.', v_p.name; end if;
    v_want := public.partner_tds_due(p_fy_start, v_int + v_rem);
    if v_tds <> v_want then
      raise exception '%: TDS on ₹% of interest + remuneration is ₹%, not ₹%.', v_p.name, v_int + v_rem, v_want, v_tds;
    end if;

    v_int_tot := v_int_tot + v_int;
    v_rem_tot := v_rem_tot + v_rem;
    v_share_tot := v_share_tot + coalesce((v_line->>'profit_share')::bigint, 0);
    v_tds_tot := v_tds_tot + v_tds;
    if v_p.left_on is null or v_p.left_on >= v_end then
      v_pct_tot := v_pct_tot + v_p.profit_share_pct;
      v_sharers := v_sharers + 1;
    end if;
  end loop;

  -- The whole: remuneration within the limit, the shares by ratio, nothing left over.
  v_book := p_net_profit - v_int_tot;
  v_max := public.partner_remuneration_limit(p_fy_start, v_book);
  if v_rem_tot > v_max then
    raise exception 'Remuneration ₹% is more than the ₹% allowed on a book profit of ₹%.', v_rem_tot, v_max, v_book;
  end if;
  if v_sharers = 0 or abs(v_pct_tot - 100) > 0.01 * v_sharers then
    raise exception 'Profit shares add up to % — they must add up to 100%% before the profit can be split.', v_pct_tot || '%';
  end if;
  v_residual := p_net_profit - v_int_tot - v_rem_tot;
  if v_share_tot <> v_residual then
    raise exception 'Interest ₹% + remuneration ₹% + shares ₹% must equal the net profit ₹%.', v_int_tot, v_rem_tot, v_share_tot, p_net_profit;
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_p from public.firm_partners where id = (v_line->>'partner_id')::uuid;
    v_share := coalesce((v_line->>'profit_share')::bigint, 0);
    v_want := case when v_p.left_on is not null and v_p.left_on < v_end then 0
                   else round(v_residual * v_p.profit_share_pct / 100.0) end;
    if abs(v_share - v_want) > 1 then
      raise exception '%: share of profit at % of ₹% is ₹%, not ₹%.', v_p.name, v_p.profit_share_pct || '%', v_residual, v_want, v_share;
    end if;
  end loop;

  v_section := case when p_fy_start >= 2026 then '393(3)' else '194T' end;
  insert into public.partner_appropriations
    (tenant_id, fy_start, posted_on, net_profit, interest_total, book_profit, max_remuneration,
     remuneration_total, residual, tds_total, created_by)
  values
    (v_tenant, p_fy_start, v_end, p_net_profit, v_int_tot, v_book, v_max, v_rem_tot, v_residual, v_tds_tot, auth.uid())
  returning id into v_id;

  insert into public.partner_appropriation_lines
    (tenant_id, appropriation_id, partner_id, share_pct, capital_base, interest_days, deed_interest_pct,
     interest_pct, interest, working, deed_remuneration, remuneration, profit_share, tds, tds_section)
  select v_tenant, v_id, fp.id, fp.profit_share_pct,
         (l->>'capital_base')::bigint, (l->>'interest_days')::int, coalesce((l->>'deed_interest_pct')::numeric, 0),
         coalesce((l->>'interest_pct')::numeric, 0), coalesce((l->>'interest')::bigint, 0), coalesce((l->>'working')::boolean, false),
         coalesce((l->>'deed_remuneration')::bigint, 0), coalesce((l->>'remuneration')::bigint, 0),
         coalesce((l->>'profit_share')::bigint, 0), coalesce((l->>'tds')::bigint, 0),
         case when coalesce((l->>'tds')::bigint, 0) > 0 then v_section end
    from jsonb_array_elements(p_lines) l
    join public.firm_partners fp on fp.id = (l->>'partner_id')::uuid;

  return v_id;
end;
$$;

revoke all on function public.post_partner_appropriation(integer, bigint, jsonb) from public, anon;
grant execute on function public.post_partner_appropriation(integer, bigint, jsonb) to authenticated, service_role;

-- ── 4. Undo a year's split (the latest one only) ─────────────────────────────────────────
create or replace function public.undo_partner_appropriation(p_fy_start integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_row      public.partner_appropriations;
  v_later    integer;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can undo the profit split' using errcode = '42501';
  end if;
  select * into v_row from public.partner_appropriations
   where tenant_id = v_tenant and fy_start = p_fy_start for update;
  if not found then raise exception 'There is no profit split posted for that year.'; end if;
  select min(fy_start) into v_later from public.partner_appropriations
   where tenant_id = v_tenant and fy_start > p_fy_start;
  if v_later is not null then
    raise exception 'FY %-% is split too and its interest uses this year''s closing capital — undo FY %-% first.',
      v_later, lpad(((v_later + 1) % 100)::text, 2, '0'), v_later, lpad(((v_later + 1) % 100)::text, 2, '0');
  end if;
  delete from public.partner_appropriations where id = v_row.id;
end;
$$;

revoke all on function public.undo_partner_appropriation(integer) from public, anon;
grant execute on function public.undo_partner_appropriation(integer) to authenticated, service_role;

-- ── 5. A partner with a posted split cannot be deleted (plain message, not a key error) ──
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
  /* R-1849 */
  if exists (select 1 from public.partner_appropriation_lines where partner_id = p_id) then
    raise exception '% has a year-end profit split posted — set a leaving date instead of deleting.', v_row.name;
  end if;
  delete from public.firm_partners where id = p_id;
end;
$$;

revoke all on function public.delete_firm_partner(uuid) from public, anon;
grant execute on function public.delete_firm_partner(uuid) to authenticated, service_role;

-- ── 6. Balance Sheet: TDS payable includes partner TDS (R-1849) ──────────────────────────
--   Same as 20261024230000 (R-1891) except dues_vendor_tds.
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
                            and t.matched_to_id = p.id::text))
   + (select coalesce(sum(pp.amount), 0)
        from public.project_payments pp
       where pp.tenant_id = v_tenant and pp.bank_txn_id is null))::bigint,
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
       where cc.tenant_id = v_tenant and cc.status = 'open'))::bigint,
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
    (select coalesce(sum(greatest(0, pa.total_amount - pa.consumed_amount)), 0)::bigint
       from public.prepaid_advances pa where pa.tenant_id = v_tenant),
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
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0)), 0)::bigint
       from public.expenses e
      where e.tenant_id = v_tenant and e.paid = false and e.reconciled_txn_id is null
        and e.expense_date <= v_to
        and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
        and e.prepaid_advance_id is null and e.id not like 'EXP-RZPFEE-%'
        and not public.report_expense_has_own_credit(v_tenant, e.id)),
    -- S45-SLICE2 (G2): "paid" expenses jinki koi bank line match nahi — cash / UPI jo bank
    -- me abhi dikha nahi. Paisa haath se gaya; undeposited funds ka aaina (cash ka ulta).
    -- Jinka Cr pehle se kahin hai wo bahar: payroll/statutory (salary payable + dues),
    -- reimbursement (reimbursements payable), emi (loan + apni bank line), advance
    -- (employee loan / prepaid), EXP-RZPFEE-* (undeposited se ghata).
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0)), 0)::bigint
       from public.expenses e
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
