-- deploy-peek: to_regprocedure('public.personal_file_support_ticket(text,text,text,text)') is not null
-- 20261030221233_r2176_personal_file_support_ticket.sql
--
-- R-2176 (GP-10c, goal G-PERSONAL, 30 Oct 2026): a personal login's Help → Report a problem
-- becomes ONE ticket on the support desk of the company it is a customer of — its free support
-- plan (decision on the card: the support desk, never the business `feedback` table).
--
-- THE GAP (localhost check of 4957282b0): the route read public.users and inserted
-- support_tickets with the service-role client. Under DATA_GATEWAY=1 that client is app_service,
-- which has no RLS bypass: public.users has no service_role policy (the role read came back
-- empty → 403 NOT_PERSONAL for a real personal user) and support_tickets' insert policies need
-- current_tenant_id()/current_customer_id() (refused).
--
-- WHAT IS HERE — one SECURITY DEFINER function, called by the signed-in user's OWN session:
--   personal_file_support_ticket(p_subject, p_body, p_category = 'tech', p_priority = 'normal')
--     · everything comes from the caller (public.current_user_id(): auth.uid() through PostgREST,
--       app.user_id through the data gateway, R-1901) — no user, tenant or customer parameter;
--     · the caller must be personal: users.role 'personal' OR the tenant's workspace_kind
--       'personal' (the data gateway's either-one rule, R-2125)          else R2176_NOT_PERSONAL;
--     · the desk + customer come from personal_identity_link (GP-16a) with link_status
--       'linked' and a customer of that seller tenant                    else R2176_NOT_LINKED;
--     · at most 10 app tickets per caller per hour (an advisory lock per caller makes the count
--       and the insert one step)                                          else R2176_TOO_MANY;
--     · inserts the ticket like an inbound support mail (run-support-agent.ts) but on channel
--       'app' with the KNOWN customer, raised_by_user = the caller, the link's verified email;
--       tier + sla_due_at are stamped by stamp_support_ticket_sla (no paid support plan =
--       'free', 24 h) and notify_ticket_created tells the seller's owners/managers;
--     · returns the ticket number (TKT-…, the same shape as lib/inbound/routing newTicketId).
--   Bad input (empty body, unknown category/priority) → R2176_BAD_INPUT; no session →
--   R2176_NOT_SIGNED_IN. Messages start with the code; the route maps them.
--
-- Named personal_* so the data gateway's personal allowlist ratchet (R-2125) lists it. -- personal-rpc
-- Grants: authenticated only (anon, public revoked). Test:
-- supabase/tests/r2176_personal_file_support_ticket.test.sql

begin;

create or replace function public.personal_file_support_ticket(
  p_subject  text,
  p_body     text,
  p_category text default 'tech',
  p_priority text default 'normal'
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  /* current_user_id(): auth.uid() for PostgREST / local, app.user_id for the gateway logins
     (app_runtime / app_jobs, R-1901) — session_user is unchanged inside SECURITY DEFINER. */
  v_uid      uuid := public.current_user_id();
  v_role     text;
  v_name     text;
  v_kind     text;
  v_seller   uuid;
  v_customer uuid;
  v_email    text;
  v_body     text := btrim(coalesce(p_body, ''));
  v_subject  text := btrim(coalesce(p_subject, ''));
  v_n        int;
  v_id       text;
begin
  /* R-2176 */
  if v_uid is null then
    raise exception 'R2176_NOT_SIGNED_IN: sign in again, then send the report.' using errcode = '28000';
  end if;

  select u.role::text, u.full_name, t.workspace_kind::text
    into v_role, v_name, v_kind
    from public.users u
    left join public.tenants t on t.id = u.tenant_id
   where u.id = v_uid;
  if coalesce(v_role, '') <> 'personal' and coalesce(v_kind, '') <> 'personal' then
    raise exception 'R2176_NOT_PERSONAL: this is for personal accounts.' using errcode = '42501';
  end if;

  if v_body = '' or length(v_body) > 8000 or length(v_subject) > 300
     or coalesce(p_category, '') not in ('billing', 'tech', 'plan_change', 'feature', 'other')
     or coalesce(p_priority, '') not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'R2176_BAD_INPUT: the report is empty, too long or has an unknown kind.' using errcode = '22023';
  end if;

  select l.seller_tenant_id, l.anutech_customer_id, nullif(btrim(l.email), '')
    into v_seller, v_customer, v_email
    from public.personal_identity_link l
    join public.customers c on c.id = l.anutech_customer_id and c.tenant_id = l.seller_tenant_id
   where l.auth_user_id = v_uid
     and l.link_status = 'linked'
     and l.seller_tenant_id is not null;
  if v_seller is null or v_email is null then
    raise exception 'R2176_NOT_LINKED: no support desk is linked to this login yet.' using errcode = 'P0002';
  end if;

  /* one caller at a time, so ten parallel requests cannot all read 9 */
  perform pg_advisory_xact_lock(hashtextextended('r2176:' || v_uid::text, 0));
  select count(*) into v_n
    from public.support_tickets s
   where s.tenant_id = v_seller
     and s.raised_by_user = v_uid
     and s.channel = 'app'
     and s.created_at > now() - interval '1 hour';
  if v_n >= 10 then
    raise exception 'R2176_TOO_MANY: 10 reports in the last hour.' using errcode = 'P0001';
  end if;

  if v_subject = '' then v_subject := left(split_part(v_body, E'\n', 1), 120); end if;
  v_id := 'TKT-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
          || '-' || upper(lpad(to_hex((random() * 255)::int), 2, '0'));

  insert into public.support_tickets
    (id, tenant_id, customer_id, customer_name, raised_by_email, raised_by_user,
     channel, category, priority, subject, body, status)
  values
    (v_id, v_seller, v_customer, coalesce(nullif(btrim(v_name), ''), v_email), v_email, v_uid,
     'app', p_category, p_priority, v_subject, v_body, 'open');

  return v_id;
end;
$$;

revoke all on function public.personal_file_support_ticket(text, text, text, text) from public, anon, service_role;
grant execute on function public.personal_file_support_ticket(text, text, text, text) to authenticated;

commit;
