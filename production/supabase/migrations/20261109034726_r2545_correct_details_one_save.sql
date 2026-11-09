-- deploy-peek: exists(select 1 from pg_proc where proname = 'correct_subscription_details' and pronamespace = (select oid from pg_namespace where nspname = 'public') and prosrc like '%R-2545%')
-- deploy-key: r2545correctdetailsonesave
-- 20261109034726_r2545_correct_details_one_save.sql
--
-- R-2545 (found 7 Nov 2026 on localhost, R-2543 check) — "Correct details" saved in steps.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   The Correct details dialog sent up to four separate requests, one after another:
--   correct_subscription_data (owner's seats / MRR fix), correct_subscription_terms (plan),
--   correct_subscription_commitment (term / payment frequency), then a plain UPDATE of vendor,
--   domain, start, renewal and payment-due dates. Each one committed on its own. On R800 Check Co
--   (yearly → quarterly + renewal 29 Mar 2027) the R-2533 trigger refused the renewal date in the
--   LAST request, but the payment frequency had already been saved — the record was left
--   half-changed.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   One function, correct_subscription_details, runs the same steps in the same order inside ONE
--   transaction (a function call is one statement). Any refusal — a role check, a missing reason,
--   the R-2533 / R-2605 / R-2613 triggers — rolls back every step, including trigger side effects
--   (e.g. R-2613 moving a scheduled seat cut) and the activity-log / amendment rows.
--   The three step functions are called unchanged (their own role, reason and company checks
--   stay). SECURITY INVOKER on purpose: the last UPDATE runs under the caller's RLS exactly as the
--   old direct UPDATE did; the step functions are SECURITY DEFINER themselves.
--   A step is skipped when its inputs are null (as the dialog skipped the request before):
--     data fix     — p_data_seats / p_data_mrr
--     plan         — p_item_id
--     commitment   — p_term_months / p_billing_cycle (p_commitment_renewal goes with it)

begin;

create or replace function public.correct_subscription_details(
  p_subscription_id    uuid,
  p_reason             text,
  p_vendor             text,
  p_domain             text,
  p_start_date         date,
  p_renewal_date       date,
  p_payment_due_date   date,
  p_data_seats         integer default null,
  p_data_mrr           integer default null,
  p_item_id            text default null,
  p_seats              integer default null,
  p_mrr                integer default null,
  p_term_months        integer default null,
  p_billing_cycle      public.billing_cycle default null,
  p_commitment_renewal date default null
) returns void
language plpgsql
security invoker
set search_path = public
as $$
/* R-2545: Correct details is one save — every step or none. */
declare
  v_rows integer;
begin
  if p_subscription_id is null then
    raise exception 'Subscription not found. Refresh the page and try again.' using errcode = '22023';
  end if;

  -- 1. Owner's data correction of seats / MRR (record fix, no money).
  if p_data_seats is not null or p_data_mrr is not null then
    perform public.correct_subscription_data(p_subscription_id, p_data_seats, p_data_mrr, p_reason);
  end if;

  -- 2. The plan (correct_subscription_terms refuses a seats / MRR change; after step 1 the record
  --    already holds the corrected seats / MRR).
  if p_item_id is not null then
    perform public.correct_subscription_terms(p_subscription_id, p_item_id, p_seats, p_mrr, p_reason);
  end if;

  -- 3. Commitment (term_months) and payment frequency (billing_cycle).
  if p_term_months is not null or p_billing_cycle is not null then
    perform public.correct_subscription_commitment(p_subscription_id, p_term_months, p_billing_cycle,
                                                   p_commitment_renewal, p_reason);
  end if;

  -- 4. The record's own fields — as the old direct UPDATE (caller's RLS). Blank domain keeps the
  --    recorded one; blank dates clear (the dialog says so); no status here (R-2228).
  update public.subscriptions s
     set vendor           = coalesce(nullif(btrim(coalesce(p_vendor, '')), '')::public.vendor, s.vendor),
         domain           = coalesce(nullif(btrim(coalesce(p_domain, '')), ''), s.domain),
         start_date       = p_start_date,
         renewal_date     = p_renewal_date,
         payment_due_date = p_payment_due_date
   where s.id = p_subscription_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'That subscription was not found in your company. Refresh the page and try again.'
      using errcode = '42501';
  end if;
end;
$$;

comment on function public.correct_subscription_details(uuid, text, text, text, date, date, date, integer, integer, text, integer, integer, integer, public.billing_cycle, date) is
  'R-2545: Correct details in ONE transaction — data fix, plan, commitment and the record fields; any refusal saves nothing.';

revoke all on function public.correct_subscription_details(uuid, text, text, text, date, date, date, integer, integer, text, integer, integer, integer, public.billing_cycle, date) from public, anon;
grant execute on function public.correct_subscription_details(uuid, text, text, text, date, date, date, integer, integer, text, integer, integer, integer, public.billing_cycle, date) to authenticated, service_role;

commit;
