-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.release_expired_plan_change_quotes(uuid)') and prosrc like '%R-2590%')
-- deploy-key: r2590expiredplanchangerelease
-- 20261108184500_r2590_expired_plan_change_release.sql
--
-- R-2590 (c) (8 Nov 2026, R-2227 independent review, low): a Change plan quote (R-2227) is linked to
-- its subscription through renewal_quote_id (extension_months = 0, first line carries plan_change).
-- Nothing ever closed it when its validity ended unpaid: the stored status stayed draft / sent and
-- the link stayed, so
--   * the renewals cron's createOrGetRenewalQuote returned THAT quote as the "renewal quote"
--     (existingQuoteId) — a reminder could carry a lapsed plan-change price instead of the renewal;
--   * Change plan / Extend / Add seats answered "already has an open quote" for ever;
--   * R-2605 treats a stored 'expired' plan-change quote as closed — but nothing stored it.
--
-- New: public.release_expired_plan_change_quotes(p_tenant_id uuid default null) → table(subscription_id, quote_id), one row per quote released.
-- For every subscription whose LINKED quote is a plan-change quote that
--   - is still waiting (status draft / sent / viewed, or accepted with no money — acceptance alone
--     changes nothing on the subscription),
--   - has an expires_date more than 2 days before today (IST, public.ist_today()). The 2 days are a
--     safety margin: a payment started on the last valid day (UPI / Razorpay) can land a little
--     later, and record_payment refuses a plan-change quote that is no longer linked (R-2227),
--   - has no money on it (payment_status none / awaiting, no invoice_id, no 'received' payment row;
--     a refunded row does not hold it),
-- the link is cleared and the quote's status becomes 'expired' (superseded_by stays null — "expired by
-- date", R-2605's "closed"). Money outranks the date (R-1679): a part-paid quote stays linked.
-- Renewal / extension quotes (extension_months > 0) and R-2073 support upgrades (no plan_change) are
-- NOT touched. Rows are locked (subscription + quote, SKIP LOCKED: a payment in flight wins), and the
-- clear is guarded on renewal_quote_id = that quote, so two overlapping runs release once.
-- Called by the renewals cron (service role) at the start of each run. Server-only: no grant to
-- anon / authenticated.
-- Proof: supabase/tests/r2590_expired_plan_change_release.test.sql.

create or replace function public.release_expired_plan_change_quotes(p_tenant_id uuid default null)
returns table(subscription_id uuid, quote_id text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := public.ist_today();
  r record;
begin
  /* R-2590: an expired, unpaid Change plan quote lets go of the subscription's renewal link. */
  for r in
    select s.id as sub_id, s.tenant_id, q.id as quote_id
      from public.subscriptions s
      join public.quotes q on q.tenant_id = s.tenant_id and q.id = s.renewal_quote_id
     where (p_tenant_id is null or s.tenant_id = p_tenant_id)
       and coalesce(q.extension_months, -1) = 0
       and jsonb_typeof(q.line_items) = 'array'
       and jsonb_typeof(q.line_items->0->'plan_change') = 'object'
       and q.status::text in ('draft', 'sent', 'viewed', 'accepted')
       and q.expires_date is not null and q.expires_date < v_today - 2
       and coalesce(q.payment_status::text, 'none') in ('none', 'awaiting')
       and q.invoice_id is null
       and not exists (select 1 from public.payments p where p.tenant_id = q.tenant_id and p.quote_id = q.id and p.status::text = 'received')
     for update of s, q skip locked
  loop
    update public.subscriptions
       set renewal_quote_id = null
     where id = r.sub_id and tenant_id = r.tenant_id and renewal_quote_id = r.quote_id;
    if found then
      update public.quotes set status = 'expired'
       where tenant_id = r.tenant_id and id = r.quote_id;
      subscription_id := r.sub_id;
      quote_id := r.quote_id;
      return next;
    end if;
  end loop;
  return;
end;
$$;

comment on function public.release_expired_plan_change_quotes(uuid) is
  'R-2590: an unpaid Change plan quote (R-2227) whose validity ended more than 2 days before today (IST) → status expired and the subscription''s renewal_quote_id cleared. Money on it (payment / invoice) keeps it linked. Renewal, extension and support-upgrade quotes untouched. Renewals cron, service role only. Returns one row (subscription_id, quote_id) per quote released.';

revoke all on function public.release_expired_plan_change_quotes(uuid) from public, anon, authenticated;
grant execute on function public.release_expired_plan_change_quotes(uuid) to service_role;
