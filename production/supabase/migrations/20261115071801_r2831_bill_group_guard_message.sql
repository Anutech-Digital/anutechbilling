-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_subscriptions_bill_group_guarded()') and prosrc like '%grouped for billing with other subscriptions%')
-- deploy-key: r2831billgroupguardmessage
-- 20261115071801_r2831_bill_group_guard_message.sql
--
-- R-2831 (15 Nov 2026, p1) — R-2807b leftovers of "Bill together". Only the WORDS of one refusal change.
--
-- trg_subscriptions_bill_group_guarded (R-2806, 20261114161903) refused a browser login moving a grouped subscription
-- to another customer with "… take it out of Bill together on Renewals first." No screen can do that: nothing
-- un-groups a subscription (R-2810: Cancel never clears a bill group). The message now says plainly that the
-- subscription is grouped for billing and that support has to move it. Same function name, no arguments, same
-- trigger, same rules (CREATE OR REPLACE of the R-2806 body — only the second message differs).
-- Test: supabase/tests/r2831_bill_group_guard_message.test.sql (one transaction, rolled back).

begin;

create or replace function public.tg_subscriptions_bill_group_guarded()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  /* R-2806 (rev-r2806 F3): bill_group_id decides whose money pays whose part, so a browser login may not set
     or change it — only server code (a SECURITY DEFINER RPC such as R-2810's Bill together, the service role,
     a direct DB session). Same rule as trg_quotes_proforma_columns_guarded (R-2519c): the login decides,
     never a settable flag or a role claim (public.is_direct_request_login, R-2485). */
  if not public.is_direct_request_login() then
    return new;
  end if;
  if (tg_op = 'INSERT' and new.bill_group_id is not null)
     or (tg_op = 'UPDATE' and new.bill_group_id is distinct from old.bill_group_id) then
    raise exception 'Which subscriptions are billed together is set only by Bill together on Renewals — it cannot be changed by hand.'
      using errcode = '42501';
  end if;
  /* rev2 (R-2806): a grouped subscription moved to another customer would carry the group (and its shared
     money) across customers — refused for a browser login. R-2831: no screen un-groups a subscription (Cancel
     never clears a bill group, R-2810), so the message names the only way: support. */
  if tg_op = 'UPDATE' and old.bill_group_id is not null and new.customer_id is distinct from old.customer_id then
    raise exception 'This subscription is grouped for billing with other subscriptions of this customer (Bill together), so it cannot move to another customer by hand. Ask support to move it.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_subscriptions_bill_group_guarded() from public, anon, authenticated;

commit;
