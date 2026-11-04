-- deploy-peek: exists(select 1 from pg_attribute where attrelid = to_regclass('public.bank_accounts') and attname = 'closed_on' and not attisdropped) and exists(select 1 from pg_trigger where tgname = 'trg_bank_account_close_guard' and tgrelid = to_regclass('public.bank_accounts')) and to_regprocedure('public.close_bank_account(uuid,date,text)') is not null and to_regprocedure('public.reopen_bank_account(uuid)') is not null
-- deploy-key: r2384closebankaccount
-- 20261102134054_r2384_close_bank_account
--
-- R-2384 (p1, 2 Nov 2026 — Pardeep: "jo FD break ho chuki ho unhe archive me rakho aur latest
-- update show karo"). Staging has five FDs broken on 10 Apr, each now at ₹0, and Banking could
-- not put them away: the account menu had View / Edit / Delete only and bank_accounts.is_active
-- (baseline, default true) had no screen.
--
-- WHAT THIS ADDS
--   1. bank_accounts.closed_on (date) + closed_note (text) — when and why an account was closed.
--   2. trg_bank_account_close_guard (BEFORE UPDATE OF is_active): an account can go inactive only
--      when its balance (opening_balance + Σ credit − debit over ALL its lines — the same sum as
--      bank_account_current_balance) is exactly ₹0, and never the company's default Petty Cash
--      (R-1834 — every cash default points at it). Closing stamps closed_on (IST today when not
--      given); reopening clears closed_on / closed_note. This holds for EVERY write path (the
--      RPCs below, a direct PostgREST update, a future screen), not only the dialog.
--   3. close_bank_account(account, closed_on, note) / reopen_bank_account(account) — the two
--      buttons. SECURITY INVOKER: bank_accounts' RLS (tenant + owner/manager/accountant write,
--      20260930175000_role_hardening) applies; the explicit role check only turns a silent
--      0-row update into a clear 42501. Closed date: not in the future, not before the last line.
--
-- Nothing is deleted: a closed account keeps every line, match and report figure (history reads
-- do not filter is_active). Pickers for NEW money already offer active accounts only
-- (lib/payments/deposit-accounts depositAccounts, brs, bills, loans …; R-2384 adds the rest).
-- Test: supabase/tests/r2384_close_bank_account.test.sql (rolled back).

begin;

alter table public.bank_accounts
  add column if not exists closed_on   date,
  add column if not exists closed_note text;

comment on column public.bank_accounts.closed_on is
  'R-2384: the day the account was closed (is_active = false). Set by tg_bank_account_close_guard; cleared on reopen.';
comment on column public.bank_accounts.closed_note is
  'R-2384: optional note given when the account was closed, e.g. "FD broken, money moved to HDFC Current".';

create or replace function public.tg_bank_account_close_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_balance bigint;
begin
  /* R-2384: close only at ₹0; reopen clears the close stamp. */
  if old.is_active and not new.is_active then
    if new.is_default_petty_cash then
      raise exception 'The company''s Petty Cash cannot be closed — it is the default cash account.'
        using errcode = '23514';
    end if;
    select coalesce(new.opening_balance, 0)::bigint
         + coalesce(sum(t.credit - t.debit), 0)::bigint
      into v_balance
      from public.bank_transactions t
     where t.bank_account_id = new.id;
    if v_balance <> 0 then
      raise exception 'This account still has a balance of ₹% — an account can be closed only at ₹0. Move the money out first (Own transfer), then close it.', v_balance
        using errcode = '23514';
    end if;
    new.closed_on := coalesce(new.closed_on, public.ist_today());
  elsif not old.is_active and new.is_active then
    new.closed_on   := null;
    new.closed_note := null;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_bank_account_close_guard on public.bank_accounts;
create trigger trg_bank_account_close_guard
  before update of is_active on public.bank_accounts
  for each row execute function public.tg_bank_account_close_guard();

revoke all on function public.tg_bank_account_close_guard() from public;

create or replace function public.close_bank_account(p_account_id uuid, p_closed_on date, p_note text default null)
 returns void
 language plpgsql
 security invoker
 set search_path to 'public'
as $function$
declare
  v_acc  public.bank_accounts;
  v_last date;
  v_on   date := coalesce(p_closed_on, public.ist_today());
begin
  /* R-2384: same write roles as bank_accounts' RLS (owner / manager / accountant). Trusted =
     service_role or a direct DB session with no request role (R-454 / R-885 pattern). */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can close a bank account' using errcode = '42501';
  end if;

  select * into v_acc from public.bank_accounts
   where id = p_account_id and tenant_id = public.current_tenant_id();
  if not found then
    raise exception 'Bank account not found';
  end if;
  if not v_acc.is_active then
    raise exception 'This account is already closed';
  end if;
  if v_on > public.ist_today() then
    raise exception 'The closed date cannot be in the future';
  end if;
  select max(txn_date) into v_last from public.bank_transactions where bank_account_id = v_acc.id;
  if v_last is not null and v_on < v_last then
    raise exception 'The closed date cannot be before the last line on this account (%)', to_char(v_last, 'DD Mon YYYY');
  end if;

  update public.bank_accounts
     set is_active   = false,
         closed_on   = v_on,
         closed_note = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at  = now()
   where id = v_acc.id and tenant_id = v_acc.tenant_id;
end;
$function$;

create or replace function public.reopen_bank_account(p_account_id uuid)
 returns void
 language plpgsql
 security invoker
 set search_path to 'public'
as $function$
declare
  v_acc public.bank_accounts;
begin
  /* R-2384: undo of close_bank_account — same roles. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can reopen a bank account' using errcode = '42501';
  end if;
  select * into v_acc from public.bank_accounts
   where id = p_account_id and tenant_id = public.current_tenant_id();
  if not found then
    raise exception 'Bank account not found';
  end if;
  if v_acc.is_active then
    raise exception 'This account is not closed';
  end if;
  update public.bank_accounts
     set is_active = true, updated_at = now()
   where id = v_acc.id and tenant_id = v_acc.tenant_id;
end;
$function$;

revoke all on function public.close_bank_account(uuid, date, text) from public;
revoke all on function public.reopen_bank_account(uuid) from public;
grant execute on function public.close_bank_account(uuid, date, text) to authenticated, service_role;
grant execute on function public.reopen_bank_account(uuid) to authenticated, service_role;

comment on function public.close_bank_account(uuid, date, text) is
  'R-2384: close (archive) a bank account at ₹0 — hidden from Banking and new-money pickers, kept in history. Balance check in trg_bank_account_close_guard.';
comment on function public.reopen_bank_account(uuid) is
  'R-2384: reopen a closed bank account (clears closed_on / closed_note).';

commit;
