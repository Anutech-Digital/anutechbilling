-- deploy-peek: to_regprocedure('public.claim_support_sync_outbox(integer,uuid[])') is not null and to_regprocedure('public.finish_support_sync_outbox(uuid,boolean,text)') is not null
-- deploy-key: r2067supportsyncoutbox
-- 20261029000150_r2067_support_sync_outbox_claim.sql
--
-- R-2067 (29 Oct 2026): support_sync_outbox had a writer and no reader.
-- trg_queue_support_sync / trg_queue_support_sync_on_customer_status queue a
-- {event_type:'subscription.updated', data:{billing_customer_id, email, plan, plan_status,
-- plan_expiry, …}} row whenever a support subscription is created or its plan / status /
-- renewal date changes, but nothing sent them — a support plan sold on a quote never reached
-- the support desk (DSP), so the customer stayed on Free there.
--
-- The sender is the cron route /api/cron/support-sync. This migration gives it the two
-- atomic steps it needs (CLAUDE.md §17b — no read-modify-write from the app):
--
--   claim_support_sync_outbox(p_limit, p_tenant_ids)
--     · picks up to 50 'pending' rows whose next_attempt_at has passed, FOR UPDATE SKIP LOCKED,
--       and leases them for 5 minutes (next_attempt_at = now() + 5 min) so an overlapping run
--       or a crash mid-send does not send the same row twice in parallel;
--     · ONE row per customer at a time, oldest first: each row carries the customer's FULL
--       state, so a newer row must never reach DSP before an older one (the older would then
--       overwrite the newer plan). A newer row waits until the older one is sent or failed;
--     · only the companies the automation gate allows (p_tenant_ids; null = all).
--
--   finish_support_sync_outbox(p_id, p_ok, p_error)
--     · 2xx → 'sent', sent_at = now(), last_error cleared;
--     · otherwise attempts + 1, last_error (500 chars), and the row waits 5 min × 2^attempts
--       before the next try (10, 20, 40, 80 min) — a DSP outage of a couple of hours is
--       ridden out instead of burning the five tries in 25 minutes;
--     · the 5th failure → 'failed' (the cron counts it, so the health digest sees it).
--
-- New column next_attempt_at (null = due now). No existing row changes meaning: every row
-- already queued stays 'pending' with next_attempt_at null, i.e. due on the first run.
-- Test: supabase/tests/r2067_support_sync_outbox.test.sql

begin;

alter table public.support_sync_outbox
  add column if not exists next_attempt_at timestamptz;

comment on column public.support_sync_outbox.next_attempt_at is
  'R-2067: not before this time (lease while sending, back-off after a failed send). null = due now.';

-- ── claim ───────────────────────────────────────────────────────────────────
create or replace function public.claim_support_sync_outbox(
  p_limit      integer default 50,
  p_tenant_ids uuid[]  default null
)
returns table (id uuid, tenant_id uuid, customer_id uuid, payload jsonb, attempts integer, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
-- R-2067
begin
  return query
  with heads as (
    -- the oldest pending row of each customer — the only one that may go next
    select distinct on (o.customer_id) o.id
      from public.support_sync_outbox o
     where o.status = 'pending'
       and (p_tenant_ids is null or o.tenant_id = any(p_tenant_ids))
     order by o.customer_id, o.created_at, o.id
  ),
  picked as (
    select o.id
      from public.support_sync_outbox o
      join heads h on h.id = o.id
     where o.status = 'pending'
       and (o.next_attempt_at is null or o.next_attempt_at <= now())
     order by o.created_at, o.id
     limit least(greatest(coalesce(p_limit, 50), 1), 50)
       for update of o skip locked
  )
  update public.support_sync_outbox o
     set next_attempt_at = now() + interval '5 minutes'
    from picked
   where o.id = picked.id
  returning o.id, o.tenant_id, o.customer_id, o.payload, o.attempts, o.created_at;
end;
$$;

comment on function public.claim_support_sync_outbox(integer, uuid[]) is
  'R-2067: lease up to 50 due pending support-sync rows (oldest per customer, SKIP LOCKED) for the support-sync cron.';

revoke all on function public.claim_support_sync_outbox(integer, uuid[]) from public, anon, authenticated;
grant execute on function public.claim_support_sync_outbox(integer, uuid[]) to service_role;

-- ── finish ──────────────────────────────────────────────────────────────────
create or replace function public.finish_support_sync_outbox(
  p_id    uuid,
  p_ok    boolean,
  p_error text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
-- R-2067
declare
  v_status text;
begin
  update public.support_sync_outbox o
     set status          = case when p_ok then 'sent'
                                when o.attempts + 1 >= 5 then 'failed'
                                else 'pending' end,
         attempts        = case when p_ok then o.attempts else o.attempts + 1 end,
         sent_at         = case when p_ok then now() else o.sent_at end,
         last_error      = case when p_ok then null
                                else left(coalesce(nullif(btrim(p_error), ''), 'send failed'), 500) end,
         next_attempt_at = case when p_ok or o.attempts + 1 >= 5 then null
                                else now() + interval '5 minutes' * power(2, o.attempts + 1) end
   where o.id = p_id
     and o.status = 'pending'
  returning o.status into v_status;

  return v_status;  -- null: the row was not pending (already finished elsewhere)
end;
$$;

comment on function public.finish_support_sync_outbox(uuid, boolean, text) is
  'R-2067: record one support-sync send: ok → sent; else attempts+1, back-off, failed after 5.';

revoke all on function public.finish_support_sync_outbox(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.finish_support_sync_outbox(uuid, boolean, text) to service_role;

commit;
