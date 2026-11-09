-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'subscriptions_r2626_plan_change_vs_later_part')
-- deploy-key: r2626planchangevslaterpart
-- 20261109064000_r2626_plan_change_vs_later_part.sql
--
-- R-2626 (9 Nov 2026, split from R-2617 b — R-2590 / R-2227 review low; money rule family N5 / C3).
--
-- Billed in parts, Change plan (R-2227) prices the CURRENT part only: later parts are laid again at
-- the new MRR by the billing run (sync-instalments, R-527) — but only while they have no bill. A
-- later part that is ALREADY billed — a proforma raised ahead of its period (Bill next part, R-2519b)
-- or that proforma's tax invoice once paid — keeps the old plan's rate: the plan changes, that part
-- stays cheap (under-bill). Adding its difference to the plan-change quote would be charged a second
-- time when the part is freed and billed again at the new rate (credit note → R-2095 Generate,
-- Cancel proforma → R-2541 reprice), so the rule is a REFUSAL (R-2589 / R-2605 / R-2617 style):
--
--   a plan-change quote cannot be paid while a part AFTER its period is already billed — cancel that
--   proforma first (the part is billed again at the new rate on its date), or change the plan once
--   that part starts (its own invoice money is then credited by the R-2255 rule).
--
-- The app refuses it in buildPlanChange (preview AND save, lib/subscriptions/change-plan.ts) and at
-- the online pay start (lib/checkout/plan-change-stale.ts). This trigger is the guard under the row
-- lock for the race (Bill next part used after the quote was made, or the billing job requesting the
-- next part while the quote waits) — record_payment's R-2227 body applies the change in ONE update
-- that sets item_id and clears renewal_quote_id:
--
--   subscriptions_r2626_plan_change_vs_later_part (BEFORE UPDATE OF item_id): item_id changes, the
--   link renewal_quote_id is cleared in the same update, the renewal date stays, and the OLD linked
--   quote is a plan-change quote (extension_months 0, first line plan_change) → a subscription_billings
--   row of this subscription starting after the quote's plan_change.period_to (today when not stored)
--   with a live invoice (not void) or an open payment request (draft / sent / viewed / accepted, linked
--   by subscription_billing_id) → raise. Correct details, an R-2073 support upgrade (no plan_change
--   line) and a renewal (date moves on) are not touched.
--
-- The message starts "R-2626: plan change refused" so the Razorpay webhook treats it like R-2589 /
-- R-2617 (late-payment.server.ts PLAN_CHANGE_REFUSED_RE → settleRefusedPlanChange: owner told, money
-- kept as advance / refund, never booked wrongly). Stored rows are NOT changed. No role check needed
-- (trigger); auth.role() is not used.
-- Test: supabase/tests/r2626_plan_change_vs_later_part.test.sql (begin … rollback; red without this file).

begin;

create or replace function public.r2626_plan_change_vs_later_part()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-2626: a plan change priced for the current part leaves a later part that is already billed at the
   old rate. Refuse paying it while such a part exists — cancel the proforma / wait for the part. */
declare
  v_pc   jsonb;
  v_to   date;
  v_part record;
  v_name text;
begin
  select q.line_items->0->'plan_change' into v_pc
    from public.quotes q
   where q.id = old.renewal_quote_id and q.tenant_id = old.tenant_id
     and q.extension_months = 0;
  if v_pc is null or jsonb_typeof(v_pc) <> 'object' then
    return new;
  end if;
  v_to := case when coalesce(v_pc->>'period_to', '') ~ '^\d{4}-\d{2}-\d{2}$'
               then (v_pc->>'period_to')::date else public.ist_today() end;

  select b.period_index, b.period_start, b.period_end, i.id as invoice_id, rq.id as request_id
    into v_part
    from public.subscription_billings b
    left join public.invoices i
      on i.id = b.invoice_id and i.tenant_id = b.tenant_id and i.status::text <> 'void'
    left join lateral (
      select q2.id from public.quotes q2
       where q2.subscription_billing_id = b.id and q2.tenant_id = b.tenant_id
         and q2.status::text in ('draft', 'sent', 'viewed', 'accepted')
       order by q2.created_at
       limit 1) rq on true
   where b.tenant_id = new.tenant_id and b.subscription_id = new.id
     and b.period_start > v_to
     and (i.id is not null or rq.id is not null)
   order by b.period_start
   limit 1;
  if not found then
    return new;
  end if;

  v_name := case old.billing_cycle::text when 'quarterly' then 'Q' when 'half_yearly' then 'H' else 'Month ' end
            || v_part.period_index || ' ('
            || to_char(v_part.period_start, 'FMDD Mon YYYY') || ' – '
            || to_char(v_part.period_end - 1, 'FMDD Mon YYYY') || ')';
  if v_part.invoice_id is not null then
    raise exception 'R-2626: plan change refused — % is already invoiced (%) at the current plan''s rate. Change the plan once that part starts, or on the renewal quote.',
      v_name, v_part.invoice_id using errcode = 'check_violation';
  end if;
  raise exception 'R-2626: plan change refused — % already has proforma % at the current plan''s rate. Cancel that proforma first (open it → Cancel proforma), then change the plan; the part is billed again at the new rate on its date.',
    v_name, v_part.request_id using errcode = 'check_violation';
end;
$function$;
revoke all on function public.r2626_plan_change_vs_later_part() from public, anon, authenticated;

drop trigger if exists subscriptions_r2626_plan_change_vs_later_part on public.subscriptions;
create trigger subscriptions_r2626_plan_change_vs_later_part
  before update of item_id on public.subscriptions
  for each row
  when (new.item_id is distinct from old.item_id
        and old.renewal_quote_id is not null
        and new.renewal_quote_id is null
        and new.renewal_date is not distinct from old.renewal_date)
  execute function public.r2626_plan_change_vs_later_part();

commit;
