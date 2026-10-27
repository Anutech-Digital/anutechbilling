-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'loans_given' and column_name = 's185_basis') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'business_loans' and column_name = 'director_declaration') and to_regprocedure('public.give_director_loan(uuid,text,integer,date,uuid,numeric,text,date,integer,text)') is not null and to_regprocedure('public.record_director_loan_taken(uuid,integer,date,uuid,numeric,boolean,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_company_director(uuid)') and prosrc like '%R-1853%')
-- deploy-key: r1853directorloans
-- 20261024225000_r1853_director_loans.sql
--
-- R-1853 (epic R-1841, Phase 3 — Pvt Ltd): loans TO and FROM the company's directors.
--
-- Until now a loan to a director was an ordinary "Loans given" row with a typed name, and money a
-- director lent the company was a "Business loan" (or a manual Balance Sheet line) — nothing said
-- it was a director, so the Companies Act caution never showed and the Balance Sheet could not
-- show "Loans from directors" apart from bank loans.
--
-- ══ THE LAW (Companies Act 2013 as on India Code — indiacode.nic.in A2013-18.pdf, read 24 Oct) ══
--   s.185(1) (substituted w.e.f. 7-5-2018): no company shall advance a loan to its director (or
--   the holding company's director, their partner / relative, or a firm they are partners in).
--   s.185(3)(a): except to a managing or whole-time director (i) as part of the conditions of
--   service extended to all employees, or (ii) under a scheme approved by the members by special
--   resolution. s.185(4): fine ₹5 lakh – ₹25 lakh on the company, and on the officer and the
--   director (or up to 6 months' imprisonment). Private-company exemptions exist by notification —
--   that is the CA's call, so the third reason is "my CA confirmed an exemption".
--   Money FROM a director: not a deposit (Form DPT-3, G.S.R. 663(E) 29 Aug 2022 lists it among
--   exempt receipts); the written-declaration condition (Deposit Rules r.2(1)(c)(viii)) is recorded
--   as a yes / no and is for the CA to confirm.
--
-- ══ WHAT CHANGES ══════════════════════════════════════════════════════════════════════════════
--   loans_given.director_id + s185_basis — a director loan always carries its s.185 reason
--     (md_wtd_service | md_wtd_scheme | ca_confirmed); a non-director loan never does.
--   business_loans.director_id + director_declaration — a loan from a director always carries the
--     yes / no answer "do we have the director's written declaration"; a bank loan never does.
--   Both FKs are ON DELETE RESTRICT: a director with loans in the books cannot vanish from the
--   register — delete_company_director now says so in plain words (cease the director instead).
--
--   give_director_loan(...)          → owner / accountant (the loans-given roles, R-544): checks
--     the director is in THIS company's register and in office on the loan date, the company is a
--     Pvt Ltd (or type not set), the reason is one of the three and an MD/WTD reason is used only
--     for an MD/WTD. Then give_loan() books it exactly as any loan (asset + cash out) with the
--     register's name, and the row gets director_id + s185_basis — one transaction.
--   record_director_loan_taken(...)  → owner / manager / accountant (the directors-register roles;
--     billing cannot read the register): same director checks, the declaration must be answered.
--     Then record_business_loan() books it (cash in + liability) with the register's name.
--   Both: §17c fail-closed guard (no company → 28000, wrong role → 42501) before anything else.
--
-- Nothing existing is changed: every old loan has director_id = null and passes the new checks.
-- The Balance Sheet RPC is untouched — its "business loans payable" total stays the one figure;
-- the screen splits the director part out of it (lib/accounting/director-loans.ts).
-- Proof: supabase/tests/r1853_director_loans.test.sql (one rollback).

begin;

-- ── 1. Columns + rules ───────────────────────────────────────────────────────────────────
alter table public.loans_given
  add column if not exists director_id uuid references public.company_directors(id) on delete restrict,
  add column if not exists s185_basis  text;

alter table public.loans_given drop constraint if exists loans_given_s185_basis_check;
alter table public.loans_given add constraint loans_given_s185_basis_check
  check (s185_basis is null or s185_basis in ('md_wtd_service', 'md_wtd_scheme', 'ca_confirmed'));
alter table public.loans_given drop constraint if exists loans_given_director_reason;
alter table public.loans_given add constraint loans_given_director_reason
  check ((director_id is null) = (s185_basis is null));

comment on column public.loans_given.director_id is 'R-1853: the director (company_directors) this loan was given to — null for anyone else.';
comment on column public.loans_given.s185_basis  is 'R-1853: Companies Act s.185 reason picked before saving: md_wtd_service (s.185(3)(a)(i)), md_wtd_scheme (s.185(3)(a)(ii)), ca_confirmed (an exemption the CA confirmed).';

alter table public.business_loans
  add column if not exists director_id          uuid references public.company_directors(id) on delete restrict,
  add column if not exists director_declaration boolean;

alter table public.business_loans drop constraint if exists business_loans_director_declaration;
alter table public.business_loans add constraint business_loans_director_declaration
  check ((director_id is null) = (director_declaration is null));

comment on column public.business_loans.director_id          is 'R-1853: the director (company_directors) who lent this money — null for a bank / NBFC loan.';
comment on column public.business_loans.director_declaration is 'R-1853: true = the director''s written declaration (money not borrowed from others) is on file — Deposit Rules r.2(1)(c)(viii); CA to confirm.';

create index if not exists loans_given_director_idx    on public.loans_given (director_id) where director_id is not null;
create index if not exists business_loans_director_idx on public.business_loans (director_id) where director_id is not null;

-- ── 2. A loan TO a director ─────────────────────────────────────────────────────────────
create or replace function public.give_director_loan(
  p_director_id     uuid,
  p_s185_basis      text,
  p_principal       integer,
  p_given_on        date,
  p_paid_from       uuid,
  p_interest_rate   numeric default 0,
  p_repayment_plan  text    default 'one_shot',
  p_due_on          date    default null,
  p_instalments     integer default null,
  p_notes           text    default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  /* R-1853 */
  v_trusted boolean;
  v_tenant  uuid := public.current_tenant_id();
  v_type    text;
  v_dir     public.company_directors;
  v_basis   text := nullif(btrim(coalesce(p_s185_basis, '')), '');
  v_id      uuid;
begin
  /* §17c: fail closed — no company, then the money role, before anything else. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can record a loan to a director' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type is not null and v_type <> 'pvt_ltd' then
    raise exception 'Loans to directors are for a Pvt Ltd company — record this loan as a person instead.';
  end if;

  if p_director_id is null then raise exception 'Pick the director from the directors register.'; end if;
  select * into v_dir from public.company_directors where id = p_director_id and tenant_id = v_tenant;
  if not found then raise exception 'That director is not in your directors register.'; end if;
  if p_given_on is not null and v_dir.ceased_on is not null and p_given_on > v_dir.ceased_on then
    raise exception '% was not a director on % (ceased %).', v_dir.name, to_char(p_given_on, 'DD Mon YYYY'), to_char(v_dir.ceased_on, 'DD Mon YYYY');
  end if;

  if v_basis is null or v_basis not in ('md_wtd_service', 'md_wtd_scheme', 'ca_confirmed') then
    raise exception 'Pick the s.185 reason this loan is allowed — or do not give it. Companies Act s.185 bars most loans to directors.';
  end if;
  if v_basis in ('md_wtd_service', 'md_wtd_scheme') and v_dir.designation not in ('managing_director', 'whole_time_director') then
    raise exception 'That reason is only for a managing or whole-time director (s.185(3)(a)) — % is not one. Ask your CA.', v_dir.name;
  end if;

  v_id := public.give_loan(v_dir.name, 'person', p_principal, p_given_on, p_paid_from, p_interest_rate,
                           p_repayment_plan, p_due_on, p_instalments, null, null, p_notes);
  update public.loans_given set director_id = v_dir.id, s185_basis = v_basis where id = v_id;
  return v_id;
end;
$$;

revoke all on function public.give_director_loan(uuid, text, integer, date, uuid, numeric, text, date, integer, text) from public, anon;
grant execute on function public.give_director_loan(uuid, text, integer, date, uuid, numeric, text, date, integer, text) to authenticated, service_role;

-- ── 3. A loan FROM a director ───────────────────────────────────────────────────────────
create or replace function public.record_director_loan_taken(
  p_director_id     uuid,
  p_principal       integer,
  p_disbursed_on    date,
  p_deposit_account uuid,
  p_interest_rate   numeric,
  p_declaration     boolean,
  p_purpose         text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  /* R-1853 */
  v_trusted boolean;
  v_tenant  uuid := public.current_tenant_id();
  v_type    text;
  v_dir     public.company_directors;
  v_id      uuid;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can record a loan from a director' using errcode = '42501';
  end if;
  select business_type into v_type from public.tenants where id = v_tenant;
  if v_type is not null and v_type <> 'pvt_ltd' then
    raise exception 'Loans from directors are for a Pvt Ltd company — record this as a business loan instead.';
  end if;

  if p_director_id is null then raise exception 'Pick the director from the directors register.'; end if;
  select * into v_dir from public.company_directors where id = p_director_id and tenant_id = v_tenant;
  if not found then raise exception 'That director is not in your directors register.'; end if;
  if p_disbursed_on is not null and v_dir.ceased_on is not null and p_disbursed_on > v_dir.ceased_on then
    raise exception '% was not a director on % (ceased %).', v_dir.name, to_char(p_disbursed_on, 'DD Mon YYYY'), to_char(v_dir.ceased_on, 'DD Mon YYYY');
  end if;
  if p_declaration is null then
    raise exception 'Say whether you have the director''s written declaration that this money is not borrowed from others.';
  end if;
  if p_disbursed_on is null then raise exception 'Pick the date the money came in.'; end if;

  v_id := public.record_business_loan(v_dir.name, p_purpose, p_principal, p_interest_rate, null, null, p_disbursed_on, p_deposit_account);
  update public.business_loans set director_id = v_dir.id, director_declaration = p_declaration where id = v_id;
  return v_id;
end;
$$;

revoke all on function public.record_director_loan_taken(uuid, integer, date, uuid, numeric, boolean, text) from public, anon;
grant execute on function public.record_director_loan_taken(uuid, integer, date, uuid, numeric, boolean, text) to authenticated, service_role;

-- ── 4. Delete a director (R-1850 body + R-1853: not one with loans in the books) ───────────
create or replace function public.delete_company_director(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_name     text;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change the directors register' using errcode = '42501';
  end if;
  select name into v_name from public.company_directors where id = p_id and tenant_id = v_tenant;
  if not found then raise exception 'That director is not in your company.'; end if;
  /* R-1853: loans keep their director — cease the director instead of deleting. */
  if exists (select 1 from public.loans_given where director_id = p_id)
     or exists (select 1 from public.business_loans where director_id = p_id) then
    raise exception '% has loans in the books — add a cessation date instead of deleting.', v_name;
  end if;
  delete from public.company_directors where id = p_id and tenant_id = v_tenant;
end;
$$;

revoke all on function public.delete_company_director(uuid) from public, anon;
grant execute on function public.delete_company_director(uuid) to authenticated, service_role;

commit;
