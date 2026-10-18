-- deploy-peek: to_regclass('public.customer_email_sends') is not null and exists(select 1 from pg_policy where polname = 'zzz_service_role_all' and polrelid = to_regclass('public.customer_email_sends'))
-- deploy-key: r1544emailsends
--
-- R-1544 (18 Oct 2026) — a payment reminder / pending-dues email goes to the customer ONCE per
-- press of Send, however often the browser retries.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   api/collections/reminder/email and api/customers/[id]/pending-dues/email sent with no
--   idempotency key. The only guard was the dialog's disabled={busy}, which resets when the
--   request times out — so a slow network + "Send" again mailed the customer twice.
--
-- ─── THE FIX ────────────────────────────────────────────────────────────────
--   The dialog makes one requestId (uuid) when it opens. The route CLAIMS that id here BEFORE
--   it sends (same pattern as R-1538's dunning-send.server.ts):
--     • insert (tenant_id, request_id) status 'sending' — the unique key lets only ONE request
--       through; a retry that collides reads the row instead:
--         'sent'    → answers "already sent" with the first result, sends nothing;
--         'sending' → 409 "still on its way", sends nothing (it may have gone);
--         'failed'  → re-claimed (failed → sending, one winner) and sent again — nothing reached
--                     the customer the first time.
--     • after the provider answers: 'sent' (+ sent_to, the follow-up id) or 'failed'. If that
--       write fails the row stays 'sending' and is never sent again (no double email).
--   payment_followups is untouched: the follow-up is still logged only after a real send.
--
-- TENANT SAFETY (CLAUDE.md §4, §17c — fail closed): every policy needs
-- tenant_id = current_tenant_id() (NULL tenant → nothing) and a customer the caller can see.
-- A row is written as yourself (created_by cannot be forged) and only its writer changes it.
-- No delete: it is the record of what was sent. Cloud SQL: service_role gets its own policy
-- (no BYPASSRLS — R-450); staging's apply() rewrites auth.uid() → public.current_user_id().

begin;

create table if not exists public.customer_email_sends (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  request_id   uuid        not null,
  customer_id  uuid        not null references public.customers(id) on delete cascade,
  kind         text        not null check (kind in ('payment_reminder', 'pending_dues_statement')),
  status       text        not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  sent_to      text        check (sent_to is null or length(sent_to) <= 320),
  followup_id  uuid        references public.payment_followups(id) on delete set null,
  created_by   uuid        default auth.uid() references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint customer_email_sends_request_once unique (tenant_id, request_id)
);

comment on table public.customer_email_sends is
  'R-1544: one row per press of Send on a payment reminder / pending-dues email (request_id from the dialog). Claimed as sending BEFORE the send, so a retry never mails the customer twice.';

create index if not exists customer_email_sends_customer_idx
  on public.customer_email_sends (tenant_id, customer_id, created_at desc);

alter table public.customer_email_sends enable row level security;

drop policy if exists customer_email_sends_select on public.customer_email_sends;
drop policy if exists customer_email_sends_insert on public.customer_email_sends;
drop policy if exists customer_email_sends_update on public.customer_email_sends;
drop policy if exists zzz_service_role_all       on public.customer_email_sends;

-- Read: same company, a customer this user can see (the retry reads its own claim).
create policy customer_email_sends_select on public.customer_email_sends
  for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and exists (select 1 from public.customers c where c.id = customer_email_sends.customer_id)
  );

-- Claim: same company, written as yourself, a customer you can see.
create policy customer_email_sends_insert on public.customer_email_sends
  for insert to authenticated
  with check (
    tenant_id = (select public.current_tenant_id())
    and created_by = (select auth.uid())
    and exists (select 1 from public.customers c where c.id = customer_email_sends.customer_id)
  );

-- Outcome: only the person who claimed it, inside the same company.
create policy customer_email_sends_update on public.customer_email_sends
  for update to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and created_by = (select auth.uid())
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and created_by = (select auth.uid())
  );

create policy zzz_service_role_all on public.customer_email_sends
  as permissive for all to service_role using (true) with check (true);

grant select, insert, update on public.customer_email_sends to authenticated;
grant select, insert, update, delete on public.customer_email_sends to service_role;

commit;
