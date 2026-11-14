-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.roll_paid_renewal_terms(uuid)') and prosrc like '%R-2735%') and exists(select 1 from pg_trigger where tgname = 'subscription_billings_r2735_paid_part_renews' and tgrelid = to_regclass('public.subscription_billings')) and exists(select 1 from pg_trigger where tgname = 'invoices_r2735_paid_part_renews' and tgrelid = to_regclass('public.invoices')) and exists(select 1 from pg_trigger where tgname = 'subscriptions_r2735_link_cleared_renews' and tgrelid = to_regclass('public.subscriptions'))
-- deploy-key: r2735renewonpaidpart
-- 20261113124936_r2735_renew_on_paid_part.sql
--
-- R-2735 (Pardeep, 13 Nov 2026 — p0 money): "jab tak payment na aaye renew to karna hi nahi ... bill next
-- part to quote banayega, wo renewal date kyo badhata hai jab tak wo paid na ho".
--
-- ─── BEFORE ───────────────────────────────────────────────────────────────────────────────────────
-- A subscription billed in parts (monthly / quarterly / half-yearly) had its renewal_date rolled a whole
-- term on, and renewal_state set to 'renewed', the moment the next term's first part was BILLED — by
-- Renewals → "Bill next part" (generate-renewal-quote route) and by the renewals cron on the new term's
-- first day — while its proforma was still unpaid. The row left Overdue for "Later" and read "Renewed".
--
-- ─── AFTER ────────────────────────────────────────────────────────────────────────────────────────
-- The app bills the new term WITHOUT moving renewal_date and marks the term's FIRST part with
--   subscription_billings.renews_from / renews_to  = "paying this part moves renewal_date from → to".
-- When that part is PAID — its tax invoice is paid (invoices.status = 'paid'; the part request's payment
-- raises it paid through trg_payments_part_request_invoice → bill_subscription_instalment →
-- raise_subscription_billing; an 'invoice on due date' customer pays the unpaid invoice later) —
-- roll_paid_renewal_terms moves renewal_date to renews_to, renewal_state 'renewed', reminders reset:
--   - exactly once: guarded on renewal_date = renews_from (a webhook retry / second receipt is a no-op);
--   - part-paid (less than the invoice) → nothing moves; only a fully paid part renews;
--   - oldest term first: a later term paid before an earlier one waits, and rolls right after it;
--   - a cancelled proforma moves nothing (nothing was moved when it was raised); the re-billed part
--     keeps its mark;
--   - an open quote on renewal_quote_id (renewal / extension / plan change, R-808) holds the roll — paying
--     that quote moves the date itself (record_payment); when the link is cleared without that (quote
--     cancelled / unlinked), trigger subscriptions_r2735_link_cleared_renews makes the waiting roll.
-- Tenant guard (CLAUDE.md §17c): a request login rolls only its own company's subscription; trusted =
-- service_role / a non-request login (the same v_trusted rule as bill_subscription_instalment, R-2527).
-- Every payment path (record_payment, bank reconcile, Razorpay, receipts import, record_instalment_payment)
-- ends in one of the two writes the triggers below watch. Rows laid before this migration have no mark
-- → never rolled here (they were rolled when raised). No back-fill: scripts/ops/r2735-renewed-without-
-- payment-report.sql lists those for the owner's decision.
-- Only service_role writes subscription_billings (RLS: select policy only), so the mark is server-set.
--
-- Test: supabase/tests/r2735_renew_on_payment.test.sql (one transaction, rolled back).

begin;

alter table public.subscription_billings add column if not exists renews_from date;
alter table public.subscription_billings add column if not exists renews_to date;
alter table public.subscription_billings drop constraint if exists subscription_billings_renews_pair;
alter table public.subscription_billings add constraint subscription_billings_renews_pair
  check ((renews_from is null) = (renews_to is null) and (renews_to is null or renews_to > renews_from));
comment on column public.subscription_billings.renews_from is
  'R-2735: set on the first part of a term billed before the subscription renewed — paying this part moves subscriptions.renewal_date from renews_from to renews_to (roll_paid_renewal_terms).';
comment on column public.subscription_billings.renews_to is
  'R-2735: the renewal_date once this part is paid (see renews_from).';

create or replace function public.roll_paid_renewal_terms(p_subscription_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
/* R-2735: a subscription billed in parts renews only by payment. Moves renewal_date over every term whose
   marked first part (renews_from = the CURRENT renewal_date) has a PAID tax invoice, oldest first. Guarded
   on renewal_date = renews_from, so a retry / second payment moves nothing. Returns the number of terms rolled. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_sub     record;
  v_b       record;
  v_rolls   integer := 0;
  v_n       integer;
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can renew it' using errcode = '28000';
  end if;
  for i in 1..24 loop
    select s.id, s.tenant_id, s.renewal_date, s.status::text as status, s.renewal_quote_id into v_sub
      from public.subscriptions s where s.id = p_subscription_id for update;
    if not found or v_sub.renewal_date is null or v_sub.status not in ('active', 'paused')
       or v_sub.renewal_quote_id is not null then
      exit;
    end if;
    if v_caller is not null and v_sub.tenant_id is distinct from v_caller then
      raise exception 'Subscription % is not in the caller''s company', p_subscription_id using errcode = '42501';
    end if;
    select b.id, b.renews_to into v_b
      from public.subscription_billings b
      join public.invoices i on i.id = b.invoice_id and i.tenant_id = b.tenant_id
     where b.subscription_id = v_sub.id
       and b.tenant_id = v_sub.tenant_id
       and b.renews_from = v_sub.renewal_date
       and i.status = 'paid'
     order by b.term_start, b.period_index
     limit 1;
    if not found then
      exit;
    end if;
    update public.subscriptions
       set renewal_date = v_b.renews_to,
           renewal_state = 'renewed',
           reminder_count = 0,
           last_reminder_sent_at_v2 = null
     where id = v_sub.id and tenant_id = v_sub.tenant_id and renewal_date = v_sub.renewal_date
       and renewal_quote_id is null;
    get diagnostics v_n = row_count;
    exit when v_n = 0;
    v_rolls := v_rolls + 1;
  end loop;
  return v_rolls;
end;
$$;
revoke all on function public.roll_paid_renewal_terms(uuid) from public, anon, authenticated;
grant execute on function public.roll_paid_renewal_terms(uuid) to service_role;

-- A marked part got its invoice (raised paid), or its mark was written after it was paid.
create or replace function public.tg_r2735_part_renews()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2735: a marked part with an invoice → renew if that invoice is paid. */
begin
  perform public.roll_paid_renewal_terms(new.subscription_id);
  return new;
end;
$$;
revoke all on function public.tg_r2735_part_renews() from public, anon, authenticated;

drop trigger if exists subscription_billings_r2735_paid_part_renews on public.subscription_billings;
create trigger subscription_billings_r2735_paid_part_renews
  after insert or update of invoice_id, renews_from, renews_to on public.subscription_billings
  for each row
  when (new.renews_to is not null and new.invoice_id is not null)
  execute function public.tg_r2735_part_renews();

-- A marked part's invoice became paid later ('invoice on due date' customers, a later receipt).
create or replace function public.tg_r2735_invoice_paid_renews()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2735: an invoice turned paid → renew every subscription whose marked part it is. */
declare
  v_sid uuid;
begin
  for v_sid in
    select distinct b.subscription_id from public.subscription_billings b
     where b.invoice_id = new.id and b.tenant_id = new.tenant_id and b.renews_to is not null
  loop
    perform public.roll_paid_renewal_terms(v_sid);
  end loop;
  return new;
end;
$$;
revoke all on function public.tg_r2735_invoice_paid_renews() from public, anon, authenticated;

drop trigger if exists invoices_r2735_paid_part_renews on public.invoices;
create trigger invoices_r2735_paid_part_renews
  after update of status on public.invoices
  for each row
  when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function public.tg_r2735_invoice_paid_renews();

-- The open quote that held a paid part's roll was cancelled / unlinked → make the waiting roll now.
create or replace function public.tg_r2735_link_cleared_renews()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2735: renewal_quote_id cleared → a paid renewal part that was held renews now (no-op otherwise). */
begin
  perform public.roll_paid_renewal_terms(new.id);
  return new;
end;
$$;
revoke all on function public.tg_r2735_link_cleared_renews() from public, anon, authenticated;

drop trigger if exists subscriptions_r2735_link_cleared_renews on public.subscriptions;
create trigger subscriptions_r2735_link_cleared_renews
  after update of renewal_quote_id on public.subscriptions
  for each row
  when (old.renewal_quote_id is not null and new.renewal_quote_id is null)
  execute function public.tg_r2735_link_cleared_renews();

commit;
