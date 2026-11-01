-- deploy-peek: to_regclass('public.privacy_requests') is not null and to_regprocedure('public.privacy_request_verify(uuid,uuid,text)') is not null and to_regprocedure('public.privacy_request_action(uuid,text,text)') is not null
-- deploy-key: r2013privacyrequests
-- 20261101215539_r2013_privacy_requests.sql
--
-- R-2013 (2 Nov 2026, goal G-DPDP). Data rights: a person asks the company, from the public
-- website (/privacy/request), to see / correct / delete their data, to withdraw consent, or to
-- nominate someone. They prove the email is theirs with a 6-digit code; the owner (or a
-- manager) then sees the request in Settings → Privacy requests with a due-by date.
--
-- Response period: 30 days from the moment the identity is confirmed. Our own privacy policy
-- already promises "we respond inside thirty days" (site/lib/data/misc.ts, "Your rights"); the
-- DPDP Rules leave the exact period to the notice, so the notice is what we hold ourselves to.
--
-- ─── WHAT THIS ADDS ────────────────────────────────────────────────────────
--   privacy_requests            one row per request. Written only by the server (service role);
--                               the owner/manager READS verified rows of their own company.
--                               The code's hash is not readable by any signed-in user.
--   privacy_request_verify()    service role only. Checks the code (5 tries, expiry), then in
--                               ONE transaction: status open + due_by, links the person's leads
--                               and customers (same email, or same last-10-digit phone), and for
--                               "withdraw consent" writes a consent_events 'withdrawn' row per
--                               lead (R-2011's broadcast/campaign filter then skips them) and
--                               adds the email to email_suppressions (birthday + AI follow-up
--                               crons skip it). Logged in activity_log WITHOUT the person's name.
--   privacy_request_action()    owner/manager of the request's company: exported / corrected /
--                               closed. Logged in activity_log.
--   consent_events              + choice 'withdrawn', + source 'privacy_request'.
--
-- Test: supabase/tests/r2013_privacy_requests.test.sql

begin;

create table if not exists public.privacy_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  full_name       text not null check (char_length(btrim(full_name)) between 2 and 120),
  email           text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 320),
  phone           text check (phone is null or char_length(phone) <= 20),
  kind            text not null check (kind in ('access', 'correction', 'erasure', 'withdraw_consent', 'nominate')),
  details         text check (details is null or char_length(details) <= 2000),
  status          text not null default 'unverified' check (status in ('unverified', 'open', 'corrected', 'closed')),
  otp_hash        text check (otp_hash is null or otp_hash ~ '^[0-9a-f]{64}$'),
  otp_expires_at  timestamptz,
  otp_attempts    smallint not null default 0 check (otp_attempts between 0 and 10),
  verified_at     timestamptz,
  due_by          date,
  lead_ids        text[] not null default '{}',
  customer_ids    uuid[] not null default '{}',
  ip_hash         text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  note            text check (note is null or char_length(note) <= 2000),
  exported_at     timestamptz,
  closed_at       timestamptz,
  closed_by       uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint privacy_requests_due_when_verified check ((verified_at is null) = (due_by is null)),
  constraint privacy_requests_verified_status check ((status = 'unverified') = (verified_at is null))
);

comment on table public.privacy_requests is
  'R-2013 (DPDP): data-rights requests from the public website (access, correction, erasure, withdraw consent, nominate). Server writes; owner/manager read verified rows. due_by = verified + 30 days.';

create index if not exists privacy_requests_tenant_due_idx on public.privacy_requests (tenant_id, status, due_by);

alter table public.privacy_requests enable row level security;

drop policy if exists r2013_owner_manager_reads on public.privacy_requests;
create policy r2013_owner_manager_reads on public.privacy_requests
  as permissive for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and status <> 'unverified'
         and (select public.current_user_has_role('owner', 'manager')));

drop policy if exists zzz_service_role_all on public.privacy_requests;
create policy zzz_service_role_all on public.privacy_requests
  as permissive for all to service_role using (true) with check (true);

revoke all on public.privacy_requests from public, anon, authenticated, service_role;
-- Signed-in readers never see the code's hash, its expiry or the tries.
grant select (id, tenant_id, full_name, email, phone, kind, details, status, verified_at, due_by,
              lead_ids, customer_ids, note, exported_at, closed_at, closed_by, created_at, updated_at)
  on public.privacy_requests to authenticated;
grant select, insert, update on public.privacy_requests to service_role;

-- ── consent_events: a withdrawal is its own choice, from its own source ──────
alter table public.consent_events drop constraint if exists consent_events_choice_check;
alter table public.consent_events
  add constraint consent_events_choice_check check (choice in ('granted', 'denied', 'withdrawn'));

alter table public.consent_events drop constraint if exists consent_events_source_check;
alter table public.consent_events
  add constraint consent_events_source_check
  check (source in ('banner', 'checkout', 'signup', 'upgrade', 'form', 'privacy_request'));

-- ── Verify the code (service role: the public route, nobody signed in) ───────
create or replace function public.privacy_request_verify(p_tenant_id uuid, p_id uuid, p_otp_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          public.privacy_requests%rowtype;
  v_digits   text;
  v_leads    text[];
  v_custs    uuid[];
  v_due      date;
  v_lead     text;
begin
  select * into r from public.privacy_requests
   where id = p_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if r.status <> 'unverified' then
    return jsonb_build_object('ok', true, 'already', true, 'due_by', r.due_by, 'kind', r.kind);
  end if;
  if r.otp_attempts >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many');
  end if;
  if r.otp_expires_at is null or r.otp_expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if r.otp_hash is null or p_otp_hash is null or r.otp_hash <> p_otp_hash then
    update public.privacy_requests
       set otp_attempts = otp_attempts + 1, updated_at = now()
     where id = r.id;
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'left', greatest(0, 4 - r.otp_attempts));
  end if;

  /* The person's records in THIS company: the same email, or the same mobile (last 10 digits). */
  v_digits := right(regexp_replace(coalesce(r.phone, ''), '\D', '', 'g'), 10);
  select coalesce(array_agg(l.id order by l.created_at, l.id), '{}') into v_leads
    from public.leads l
   where l.tenant_id = r.tenant_id
     and (lower(btrim(coalesce(l.contact_email, ''))) = r.email
          or (char_length(v_digits) = 10
              and right(regexp_replace(coalesce(l.contact_phone, ''), '\D', '', 'g'), 10) = v_digits));
  select coalesce(array_agg(c.id order by c.created_at, c.id), '{}') into v_custs
    from public.customers c
   where c.tenant_id = r.tenant_id
     and (lower(btrim(coalesce(c.contact_email, ''))) = r.email
          or (char_length(v_digits) = 10
              and (right(regexp_replace(coalesce(c.contact_phone, ''), '\D', '', 'g'), 10) = v_digits
                   or right(regexp_replace(coalesce(c.contact_mobile, ''), '\D', '', 'g'), 10) = v_digits)));

  v_due := (now() at time zone 'Asia/Kolkata')::date + 30;

  update public.privacy_requests
     set status = 'open', verified_at = now(), due_by = v_due,
         lead_ids = v_leads, customer_ids = v_custs,
         otp_hash = null, otp_expires_at = null, updated_at = now()
   where id = r.id;

  if r.kind = 'withdraw_consent' then
    foreach v_lead in array v_leads loop
      insert into public.consent_events (tenant_id, lead_id, purpose, choice, notice_version, source)
      values (r.tenant_id, v_lead, 'marketing', 'withdrawn', 'privacy-request', 'privacy_request');
    end loop;
    insert into public.email_suppressions (tenant_id, email, reason)
    values (r.tenant_id, r.email, 'consent_withdrawn')
    on conflict (tenant_id, email) do nothing;
  end if;

  /* No name, email or phone in the label: activity_log is read widely and kept long. */
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (r.tenant_id, null, 'privacy_request.verified', 'privacy_request', r.id::text,
          'Privacy request (' || r.kind || ') confirmed — due by ' || to_char(v_due, 'DD Mon YYYY'));

  return jsonb_build_object('ok', true, 'due_by', v_due, 'kind', r.kind,
                            'leads', coalesce(array_length(v_leads, 1), 0),
                            'customers', coalesce(array_length(v_custs, 1), 0));
end;
$$;

revoke all on function public.privacy_request_verify(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.privacy_request_verify(uuid, uuid, text) to service_role;

-- ── Owner / manager actions: exported, corrected, closed ─────────────────────
create or replace function public.privacy_request_action(p_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r       public.privacy_requests%rowtype;
  v_user  uuid := public.current_user_id();
  v_label text;
begin
  if not public.current_user_has_role('owner', 'manager') then
    raise exception 'R-2013: only the owner or a manager can act on a privacy request' using errcode = '42501';
  end if;
  if p_action not in ('exported', 'corrected', 'closed') then
    raise exception 'R-2013: unknown action %', p_action using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 2000 then
    raise exception 'R-2013: the note is longer than 2000 characters' using errcode = '22023';
  end if;

  select * into r from public.privacy_requests
   where id = p_id and tenant_id = public.current_tenant_id()
   for update;
  if not found or r.status = 'unverified' then
    raise exception 'R-2013: privacy request not found' using errcode = 'P0002';
  end if;
  if r.status = 'closed' and p_action <> 'exported' then
    raise exception 'R-2013: this request is already closed' using errcode = '22023';
  end if;

  if p_action = 'exported' then
    update public.privacy_requests set exported_at = now(), updated_at = now() where id = r.id;
    v_label := 'Privacy request — data exported';
  elsif p_action = 'corrected' then
    update public.privacy_requests
       set status = 'corrected', note = coalesce(nullif(btrim(p_note), ''), note), updated_at = now()
     where id = r.id;
    v_label := 'Privacy request — marked corrected';
  else
    update public.privacy_requests
       set status = 'closed', closed_at = now(), closed_by = v_user,
           note = coalesce(nullif(btrim(p_note), ''), note), updated_at = now()
     where id = r.id;
    v_label := 'Privacy request — closed';
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (r.tenant_id, v_user, 'privacy_request.' || p_action, 'privacy_request', r.id::text, v_label);

  return jsonb_build_object('ok', true, 'action', p_action);
end;
$$;

revoke all on function public.privacy_request_action(uuid, text, text) from public, anon;
grant execute on function public.privacy_request_action(uuid, text, text) to authenticated, service_role;

commit;
