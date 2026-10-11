-- deploy-peek: (to_regclass('public.expense_claim_pin_attempts') is not null and to_regprocedure('public.claim_pin_check(uuid, uuid, text)') is not null and exists(select 1 from pg_policy where polname = 'expense_claim_pin_attempts_service_role'))
-- deploy-key: r725pin
-- 20261011134000_r725_claim_pin_lockout.sql
--
-- R-725 (P1, security audit 9–10 Oct). The public expense-claim link checks the employee's
-- 4–6 digit attendance PIN on three server routes (verify / submit / manage). Only verify had
-- a limit, and that limit lived in one Cloud Run instance's memory. Anyone holding the link
-- could guess a colleague's PIN through submit or manage — or through verify from several
-- instances — and then file claims in that person's name.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════
--
--   expense_claim_pin_attempts: a durable wrong-PIN counter per employee (survives restarts,
--   shared by every instance). Service role only — like employee_pin_attempts (R-607).
--
--   claim_pin_check(tenant, employee, pin) → text. The ONE PIN check the three routes run
--   before anything else (before the receipt upload, before the claim RPCs):
--     'ok'          right PIN — the wrong-count is cleared
--     'wrong_pin'   counted
--     'pin_locked'  every 5th wrong PIN in a row locks: 15 min, then 30, 60 … capped at 24 h.
--                   Checked BEFORE the PIN, so the right PIN cannot be confirmed while locked.
--                   A kiosk lock (employee_pin_attempts, same PIN) also locks the claim side,
--                   so the two doors do not give two separate guess budgets.
--     'not_found' / 'inactive' / 'no_pin'  — nothing counted (nothing to guess).
--   Wrong / locked are RETURNED, not raised: a raise rolls back the counter with the rest of
--   the transaction and the lock would never engage (same lesson as R-607).
--
--   The counter is NOT reset when a lock expires (unlike the kiosk) — that is what makes the
--   lock grow. Only a right PIN clears it.

begin;

create table if not exists public.expense_claim_pin_attempts (
  employee_id  uuid primary key references public.employees(id) on delete cascade,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  failed       integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.expense_claim_pin_attempts enable row level security;
drop policy if exists expense_claim_pin_attempts_service_role on public.expense_claim_pin_attempts;
create policy expense_claim_pin_attempts_service_role on public.expense_claim_pin_attempts
  as permissive for all to service_role using (true) with check (true);
revoke all on table public.expense_claim_pin_attempts from public, anon, authenticated;
grant all on table public.expense_claim_pin_attempts to service_role;

create or replace function public.claim_pin_check(p_tenant_id uuid, p_employee_id uuid, p_pin text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_hash   text;
  v_active boolean;
  v_lock   timestamptz;
  v_failed integer;
begin
  -- R-725
  select pin_hash, is_active into v_hash, v_active from public.employees
    where id = p_employee_id and tenant_id = p_tenant_id;
  if not found then return 'not_found'; end if;
  if not coalesce(v_active, false) then return 'inactive'; end if;
  if v_hash is null then return 'no_pin'; end if;

  select locked_until into v_lock from public.expense_claim_pin_attempts where employee_id = p_employee_id;
  if v_lock is not null and v_lock > now() then return 'pin_locked'; end if;
  select locked_until into v_lock from public.employee_pin_attempts where employee_id = p_employee_id;
  if v_lock is not null and v_lock > now() then return 'pin_locked'; end if;

  if p_pin is null or crypt(p_pin, v_hash) <> v_hash then
    insert into public.expense_claim_pin_attempts as a (employee_id, tenant_id, failed, updated_at)
      values (p_employee_id, p_tenant_id, 1, now())
    on conflict (employee_id) do update
      set failed = a.failed + 1, updated_at = now()
    returning failed into v_failed;
    if v_failed % 5 = 0 then
      update public.expense_claim_pin_attempts
         set locked_until = now() + least(interval '24 hours',
                                          interval '15 minutes' * power(2, least(v_failed / 5 - 1, 10)))
       where employee_id = p_employee_id;
      return 'pin_locked';
    end if;
    return 'wrong_pin';
  end if;

  delete from public.expense_claim_pin_attempts where employee_id = p_employee_id;
  return 'ok';
end;
$function$;

revoke all on function public.claim_pin_check(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_pin_check(uuid, uuid, text) to service_role;

commit;
