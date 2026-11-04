-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'loan_interest_tds') and exists(select 1 from pg_proc where oid = to_regprocedure('public.set_loan_interest_tds(text,text,text)') and prosrc like '%R-2376%')
-- deploy-key: r2376loaninteresttds
-- R-2376 (3 Nov 2026): TDS on interest paid to a NON-BANK lender — s.393(1) Table 5(iii)
-- Income-tax Act 2025 (old s.194A). Owner-delegated decision, TAX-DECISIONS memo 3 Nov §4.
--
-- OD audit (2 Nov): interest + processing fee to NBFCs (Tata Capital ~₹90k incl. fee) may need
-- 10% TDS once one lender's FY total is above ₹10,000 — nothing in the app said so. The check
-- itself is pure (lib/accounting/loan-interest-tds.ts) and reads the interest already booked
-- (business_loan_payments, emi_payments, emi_purchases.processing_fee). It posts NOTHING: the
-- owner keeps the TDS back on a repayment (reconcile_bank_debit_to_business_loan's p_tds, R-2374)
-- which lands in the existing TDS payable (dues_vendor_tds).
--
-- ══ WHAT THIS ADDS ══════════════════════════════════════════════════════════════════════
--   tenants.loan_interest_tds jsonb — the owner's answers, asked once:
--     { "off": bool,                              -- turn the check off
--       "audited": { "<FY start year>": bool },   -- proprietorship: tax-audited that FY?
--       "lenders": { "<lender key>": "bank" | "non_bank" } }
--   set_loan_interest_tds(what, key, value) — the only writer; owner / accountant.
--     what 'off'     value 'true' | 'false'
--     what 'audited' key = 4-digit FY start year, value 'true' | 'false' | null (forget)
--     what 'lender'  key = lender key (lib lenderKey), value 'bank' | 'non_bank' | null (forget)
--   No money moves here.
--
-- Proof: supabase/tests/r2376_loan_interest_tds.test.sql (one rollback).

begin;

alter table public.tenants add column if not exists loan_interest_tds jsonb not null default '{}'::jsonb;
comment on column public.tenants.loan_interest_tds is
  'R-2376: TDS on loan interest (s.393(1) T5(iii) / old 194A) — {off, audited:{fy:bool}, lenders:{key:bank|non_bank}}. Written only by set_loan_interest_tds.';

create or replace function public.set_loan_interest_tds(p_what text, p_key text, p_value text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_cur    jsonb;
  v_key    text := lower(btrim(coalesce(p_key, '')));
  v_val    text := nullif(lower(btrim(coalesce(p_value, ''))), '');
begin
  -- R-2376: owner / accountant (the tax answers); trusted = service_role or a direct DB session
  -- with no request role (R-454 / R-714 / R-717 / R-718).
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant can change the TDS on loan interest settings' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company on this login — sign in again' using errcode = '28000'; end if;

  select coalesce(loan_interest_tds, '{}'::jsonb) into v_cur from public.tenants where id = v_tenant for update;
  if not found then raise exception 'Company not found'; end if;

  if p_what = 'off' then
    if v_val is null or v_val not in ('true', 'false') then raise exception 'Off must be true or false'; end if;
    v_cur := jsonb_set(v_cur, '{off}', to_jsonb(v_val::boolean));
  elsif p_what = 'audited' then
    if v_key !~ '^[0-9]{4}$' then raise exception 'The year must be the FY start year, e.g. 2025'; end if;
    if v_val is null then
      v_cur := v_cur #- array['audited', v_key];
    elsif v_val in ('true', 'false') then
      v_cur := jsonb_set(v_cur, '{audited}', coalesce(v_cur -> 'audited', '{}'::jsonb));
      v_cur := jsonb_set(v_cur, array['audited', v_key], to_jsonb(v_val::boolean));
    else
      raise exception 'Tax-audited must be true or false';
    end if;
  elsif p_what = 'lender' then
    if v_key = '' or length(v_key) > 200 then raise exception 'Enter the lender'; end if;
    if v_val is null then
      v_cur := v_cur #- array['lenders', v_key];
    elsif v_val in ('bank', 'non_bank') then
      v_cur := jsonb_set(v_cur, '{lenders}', coalesce(v_cur -> 'lenders', '{}'::jsonb));
      v_cur := jsonb_set(v_cur, array['lenders', v_key], to_jsonb(v_val));
    else
      raise exception 'Lender type must be bank or non_bank';
    end if;
  else
    raise exception 'Unknown setting %', coalesce(p_what, '(none)');
  end if;

  update public.tenants set loan_interest_tds = v_cur where id = v_tenant;
  return v_cur;
end;
$$;
revoke all on function public.set_loan_interest_tds(text, text, text) from public, anon;
grant execute on function public.set_loan_interest_tds(text, text, text) to authenticated, service_role;

commit;
