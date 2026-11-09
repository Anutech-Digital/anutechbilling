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
--   with a live invoice (not void) or a payment request linked to it — subscription_billing_id, or a
--   line billing_id of a group request (R-2092) — not spent on an invoice credit notes cancelled
--   (R-2095); any status, like bill_subscription_instalment (a cancel unlinks it) → raise. An invoiced
--   part names the LATEST one ("change the plan once that part starts"); proformas only → all of them,
--   latest first to cancel (cancel_quote frees only the latest billed period, R-2519b).
--   Correct details, an R-2073 support upgrade (no plan_change line) and a renewal (date moves on) are
--   not touched.
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
  v_pc        jsonb;
  v_to        date;
  v_part      record;
  v_name      text;
  v_inv_name  text := null;
  v_inv_id    text := null;
  v_pf_names  text[] := '{}';
  v_pf_ids    text[] := '{}';
  v_prefix    text;
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
  v_prefix := case old.billing_cycle::text when 'quarterly' then 'Q' when 'half_yearly' then 'H' else 'Month ' end;

  /* Every later part with a bill: a live invoice, or a payment request linked to it — directly
     (subscription_billing_id) or as one of a group request's lines (line billing_id, R-2092) — that
     was not spent on an invoice credit notes cancelled (R-2095). Same "request" as
     bill_subscription_instalment: any status (a cancel unlinks it). */
  for v_part in
    select b.period_index, b.period_start, b.period_end, i.id as invoice_id, rq.id as request_id
      from public.subscription_billings b
      left join public.invoices i
        on i.id = b.invoice_id and i.tenant_id = b.tenant_id and i.status::text <> 'void'
      left join lateral (
        select q2.id from public.quotes q2
         where q2.tenant_id = b.tenant_id
           and (q2.subscription_billing_id = b.id
                or (q2.subscription_billing_id is not null and exists (
                      select 1 from jsonb_array_elements(case when jsonb_typeof(q2.line_items) = 'array'
                                                              then q2.line_items else '[]'::jsonb end) l2
                       where l2->>'billing_id' = b.id::text)))
           and not (q2.invoice_id is not null and q2.invoice_id = any(b.credited_invoice_ids))
         order by q2.created_at
         limit 1) rq on true
     where b.tenant_id = new.tenant_id and b.subscription_id = new.id
       and b.period_start > v_to
       and (i.id is not null or rq.id is not null)
     order by b.period_start
  loop
    v_name := v_prefix || v_part.period_index || ' ('
              || to_char(v_part.period_start, 'FMDD Mon YYYY') || ' – '
              || to_char(v_part.period_end - 1, 'FMDD Mon YYYY') || ')';
    if v_part.invoice_id is not null then
      v_inv_name := v_name; v_inv_id := v_part.invoice_id;   -- the LATEST invoiced part wins
    else
      v_pf_names := v_pf_names || v_name; v_pf_ids := v_pf_ids || v_part.request_id;
    end if;
  end loop;

  if v_inv_id is not null then
    raise exception 'R-2626: plan change refused — % is already invoiced (%) at the current plan''s rate. Change the plan once that part starts.',
      v_inv_name, v_inv_id using errcode = 'check_violation';
  end if;
  if cardinality(v_pf_ids) = 1 then
    raise exception 'R-2626: plan change refused — % already has proforma % at the current plan''s rate. Cancel that proforma first (open it → Cancel proforma), then change the plan; the part is billed again at the new rate on its date.',
      v_pf_names[1], v_pf_ids[1] using errcode = 'check_violation';
  end if;
  if cardinality(v_pf_ids) > 1 then
    raise exception 'R-2626: plan change refused — % already have proformas % at the current plan''s rate. Cancel them first, the latest first (open each → Cancel proforma), then change the plan; the parts are billed again at the new rate on their dates.',
      array_to_string(v_pf_names, ' and '), array_to_string(v_pf_ids, ', ') using errcode = 'check_violation';
  end if;
  return new;
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
