-- deploy-key: grantedrole
-- deploy-peek: exists(select 1 from pg_attribute where attrelid = to_regclass('public.join_requests') and attname = 'granted_role' and not attisdropped)
-- 20261011020000_join_request_granted_role.sql
--
-- R-828 (AI checker, 10 Oct). Dashboard → "Someone is waiting to join" → the owner picks a
-- role (e.g. Sales) and approves. The person really becomes Sales, but the join_requests row
-- kept requested_role = 'support' and the role actually given was stored nowhere, so anyone
-- reading the record later (audit, support) saw the wrong role. Nobody's access was wrong.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--   join_requests.granted_role — the role the owner GAVE on approval (the same value written
--   to public.users.role; for someone already in the workspace, the role they kept).
--   requested_role stays as asked, so the record shows both. NULL while pending and on reject.
--   Same type as requested_role (public.user_role enum), so only real roles can be stored —
--   no separate check constraint needed.
--
-- ══ GRANTS / RLS ═════════════════════════════════════════════════════════════════
--   join_requests uses TABLE-level grants (authenticated/anon SELECT+UPDATE, service_role ALL)
--   and has no column grants, so the new column is covered by them — nothing to add. RLS
--   policies are row-based (join_requests_select / join_requests_decide) and do not name
--   columns. The approve route writes through the server's service-role client. Not a secret.
--   Additive and idempotent: safe to re-run.

begin;

alter table public.join_requests
  add column if not exists granted_role public.user_role;

comment on column public.join_requests.granted_role is
  'R-828: role actually given when the owner approved (equals public.users.role at approval). NULL while pending or when rejected. requested_role keeps what was asked for.';

commit;
