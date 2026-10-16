-- deploy-peek: to_regclass('public.feedback_votes') is not null and exists(select 1 from pg_policy where polname = 'feedback_votes_delete_own' and polrelid = to_regclass('public.feedback_votes'))
-- deploy-key: r1466votes
-- 20261016150000_r1466_feedback_votes.sql
--
-- R-1466 (16 Oct 2026, rest of Abhishek's R-1417): "+1 / I have this too" on a report someone in
-- the same company already filed. Help → Report a problem lists the company's open reports that
-- look like what is being typed (R-1417, help-report-matches.tsx); each now gets a +1 toggle.
--
-- A vote is NOT a new feedback row (that is the duplicate the list exists to prevent). It is one
-- row per (report, user) here:
--   • unique (feedback_id, user_id) — one person, one vote; pressing again deletes it;
--   • tenant_id is the voter's company AND the report's company (insert policy checks both);
--   • no update policy — a vote is added or taken back, never edited.
--
-- RLS (CLAUDE.md §4, §17c fail closed): read = own company's votes; insert/delete = only your OWN
-- vote (user_id = auth.uid()) in your own company, and current_tenant_id() must not be NULL (a
-- deactivated user or a non-aal2 MFA session has no tenant → cannot vote). No SECURITY DEFINER.
-- auth.uid() is written plainly: staging's apply() rewrites it to public.current_user_id() for
-- Cloud SQL (see 20261016103100_r731_mfa_tenant.sql). auth.users is never referenced.
-- No money here.

begin;

create table if not exists public.feedback_votes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  feedback_id uuid not null references public.feedback(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint feedback_votes_one_per_user unique (feedback_id, user_id)
);

create index if not exists feedback_votes_tenant_feedback_idx on public.feedback_votes (tenant_id, feedback_id);
create index if not exists feedback_votes_user_idx on public.feedback_votes (user_id);

comment on table public.feedback_votes is
  'R-1466: "+1 / I have this too" on a feedback report — one row per (report, user), same tenant as the report.';

alter table public.feedback_votes enable row level security;

drop policy if exists feedback_votes_select on public.feedback_votes;
create policy feedback_votes_select on public.feedback_votes
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

drop policy if exists feedback_votes_insert_own on public.feedback_votes;
create policy feedback_votes_insert_own on public.feedback_votes
  for insert to authenticated
  with check (
    public.current_tenant_id() is not null
    and tenant_id = public.current_tenant_id()
    and user_id = auth.uid()
    and exists (
      select 1 from public.feedback f
       where f.id = feedback_votes.feedback_id
         and f.tenant_id = public.current_tenant_id()
    )
  );

drop policy if exists feedback_votes_delete_own on public.feedback_votes;
create policy feedback_votes_delete_own on public.feedback_votes
  for delete to authenticated
  using (
    public.current_tenant_id() is not null
    and tenant_id = public.current_tenant_id()
    and user_id = auth.uid()
  );

-- Cloud SQL has no BYPASSRLS: the server's service_role needs its own policy.
drop policy if exists zzz_service_role_all on public.feedback_votes;
create policy zzz_service_role_all on public.feedback_votes
  as permissive for all to service_role using (true) with check (true);

revoke all on public.feedback_votes from public;
revoke all on public.feedback_votes from anon;
grant select, insert, delete on public.feedback_votes to authenticated;
grant select, insert, update, delete on public.feedback_votes to service_role;

commit;
