-- deploy-peek: (exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'vendor_term_end') and exists(select 1 from pg_proc where oid = to_regprocedure('public.correct_subscription_with_vendor_term(uuid,text,text,text,date,date,date,date,integer,integer,text,integer,integer,integer,public.billing_cycle,date)') and prosrc like '%R-2823: Correct details + the vendor%'))
-- deploy-key: r2823vendortermend
-- 20261114224316_r2823_vendor_term_end.sql
--
-- R-2823 (Renewals 12-question audit, 14 Nov 2026) — the vendor's OWN renewal date.
--
-- ─── WHAT WAS MISSING ───────────────────────────────────────────────────────
--   Google / Microsoft renew a subscription on their own date. That date was kept nowhere: the
--   Google import writes it into renewal_date (our next term's start), and once our term moves
--   (paid renewal, corrected dates) the vendor's date is lost. The Renewals drawer could not say
--   "Google renews 12 Jan 2027" when it differs from our renewal date.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   1. subscriptions.vendor_term_end date NULL — the date the vendor itself renews (blank = not
--      known). Display only: no money, no trigger, no status reads it. Same table → the existing
--      RLS policies and grants cover it (nothing changed there).
--   2. correct_subscription_with_vendor_term — "Correct details" when the vendor date CHANGED:
--      calls correct_subscription_details (R-2545, unchanged — not redefined, not overloaded, so
--      its deploy-peek and any later redefiner stay exactly as they are) and then writes
--      vendor_term_end, in the SAME one transaction (a refused R-2545 step saves nothing). The
--      dialog calls it only when the vendor date changed; every other save still calls
--      correct_subscription_details directly.
--      SECURITY INVOKER like R-2545: the UPDATE runs under the caller's RLS plus the explicit
--      company check — who may edit it = whoever may run Correct details. Blank clears it.

begin;

alter table public.subscriptions add column if not exists vendor_term_end date;

comment on column public.subscriptions.vendor_term_end is
  'R-2823: the date the vendor (Google / Microsoft / Zoho) itself renews this subscription. NULL = not known. Display only (Renewals drawer); set in Correct details.';

create or replace function public.correct_subscription_with_vendor_term(
  p_subscription_id    uuid,
  p_reason             text,
  p_vendor             text,
  p_domain             text,
  p_start_date         date,
  p_renewal_date       date,
  p_payment_due_date   date,
  p_vendor_term_end    date,
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
/* R-2823: Correct details + the vendor's own renewal date, still ONE transaction. */
declare
  v_rows integer;
begin
  -- Every R-2545 step (data fix, plan, commitment, record fields) — that function, unchanged.
  perform public.correct_subscription_details(
    p_subscription_id    => p_subscription_id,
    p_reason             => p_reason,
    p_vendor             => p_vendor,
    p_domain             => p_domain,
    p_start_date         => p_start_date,
    p_renewal_date       => p_renewal_date,
    p_payment_due_date   => p_payment_due_date,
    p_data_seats         => p_data_seats,
    p_data_mrr           => p_data_mrr,
    p_item_id            => p_item_id,
    p_seats              => p_seats,
    p_mrr                => p_mrr,
    p_term_months        => p_term_months,
    p_billing_cycle      => p_billing_cycle,
    p_commitment_renewal => p_commitment_renewal);

  -- The vendor's own renewal date (blank clears). Caller's RLS + the explicit company check.
  update public.subscriptions s
     set vendor_term_end = p_vendor_term_end
   where s.id = p_subscription_id
     and s.tenant_id = coalesce(public.current_tenant_id(), s.tenant_id);
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'That subscription was not found in your company. Refresh the page and try again.'
      using errcode = '42501';
  end if;
end;
$$;

comment on function public.correct_subscription_with_vendor_term(uuid, text, text, text, date, date, date, date, integer, integer, text, integer, integer, integer, public.billing_cycle, date) is
  'R-2823: Correct details (correct_subscription_details, unchanged) + the vendor''s own renewal date (vendor_term_end), in ONE transaction.';

revoke all on function public.correct_subscription_with_vendor_term(uuid, text, text, text, date, date, date, date, integer, integer, text, integer, integer, integer, public.billing_cycle, date) from public, anon;
grant execute on function public.correct_subscription_with_vendor_term(uuid, text, text, text, date, date, date, date, integer, integer, text, integer, integer, integer, public.billing_cycle, date) to authenticated, service_role;

commit;
