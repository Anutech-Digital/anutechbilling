-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_payment_followups_reassign_guard()') and prosrc like '%R-1528%') and exists(select 1 from pg_trigger where tgname = 'trg_payment_followups_reassign_guard' and tgrelid = to_regclass('public.payment_followups'))
-- deploy-key: r1528reassign
--
-- R-1528 (17 Oct 2026, Pardeep → manager's call): the DATABASE now keeps R-1517's rule
-- "only owner / manager / accountant may give a payment follow-up to someone else".
--
-- WHY: R-1517 put the rule in the app (form hides the picker) and the server
-- (POST /api/collections/followups → resolveAssignee). But R-1515's RLS lets any staff role
-- who can see the customer insert a follow-up with ANY same-company person in assigned_to, and
-- its UPDATE policy lets billing (and a sales person on their own row) change assigned_to.
-- A direct PostgREST write skipped the app rule. This trigger is the same rule, in the DB.
--
-- THE RULE (same as lib/collections/followup-rules.ts → resolveAssignee / defaultAssignee)
--   • owner / manager / accountant (active, current_user_has_role): anything (same-company
--     person is still checked by trg_payment_followups_same_tenant).
--   • everyone else — sales, sales_senior, billing, support, delivery:
--       INSERT: assigned_to must be NULL, themselves, or the CURRENT DEFAULT =
--               the latest follow-up's assigned_to for that customer, else the customer's
--               account_manager_id (exactly the app's default; the app's last fallback "me"
--               is the "themselves" case).
--       UPDATE: assigned_to may not change at all.
--   • billing follows the app: it cannot reassign (R-1515's UPDATE policy let it).
--
-- FAIL CLOSED (CLAUDE.md §17c): a caller with no company (NULL current_tenant_id) is refused
-- here (42501, before RLS even looks), and a row stamped with another company is refused here too — not left to RLS.
-- Trusted callers (service_role = admin client / cron, or a direct psql/script session) pass:
-- they are not a person reassigning anything. Staging rewrites auth.role() →
-- public.current_request_role() (R-161), so it is written plainly.
--
-- Error: 42501 (insufficient_privilege) with a §24 message saying what to do instead.

begin;

create or replace function public.tg_payment_followups_reassign_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
  v_me      uuid;
  v_default uuid;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_trusted then
    return new;
  end if;

  v_caller := public.current_tenant_id();
  if v_caller is null then
    raise exception 'Aapka login kisi company se juda nahi hai, isliye follow-up save nahi hua — dobara login karke try karo.'
      using errcode = '42501';  -- not 28000: R-1515's test (and the app's 403 mapping) expect insufficient_privilege
  end if;
  if new.tenant_id is distinct from v_caller then
    raise exception 'Ye follow-up aapki company ka nahi hai — Payment Follow-up page reload karke customer dobara chuno.'
      using errcode = '42501';
  end if;

  -- R-1528 reassigners: the same three as REASSIGN_ROLES in followup-rules.ts.
  if public.current_user_has_role('owner', 'manager', 'accountant') then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.assigned_to is distinct from old.assigned_to then
      raise exception 'Sirf owner, manager ya accountant follow-up kisi aur ke naam kar sakte hain — isse jiske naam hai usi ke naam rehne do, ya manager se badalwao.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- INSERT
  if new.assigned_to is null then
    return new;
  end if;
  v_me := auth.uid();
  if new.assigned_to = v_me then
    return new;
  end if;

  select coalesce(
           (select f.assigned_to
              from public.payment_followups f
             where f.customer_id = new.customer_id
               and f.tenant_id = new.tenant_id
             order by f.created_at desc, f.id desc
             limit 1),
           (select c.account_manager_id
              from public.customers c
             where c.id = new.customer_id
               and c.tenant_id = new.tenant_id))
    into v_default;

  if new.assigned_to is not distinct from v_default then
    return new;
  end if;

  raise exception 'Sirf owner, manager ya accountant follow-up kisi aur ke naam kar sakte hain — jiske naam abhi hai usi ke naam save karo, ya manager se badalwao.'
    using errcode = '42501';
end $$;

comment on function public.tg_payment_followups_reassign_guard() is
  'R-1528: only owner/manager/accountant may give a payment follow-up to someone else; others keep NULL, themselves or the current default (latest follow-up assigned_to, else customers.account_manager_id), and never change assigned_to on update. Fail-closed on NULL tenant.';

revoke all on function public.tg_payment_followups_reassign_guard() from public, anon;

drop trigger if exists trg_payment_followups_reassign_guard on public.payment_followups;
create trigger trg_payment_followups_reassign_guard
  before insert or update
  on public.payment_followups
  for each row execute function public.tg_payment_followups_reassign_guard();

commit;
