-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_social_content_approval_guard' and tgrelid = to_regclass('public.social_content')) and to_regprocedure('public.ensure_social_automation_on(text)') is not null
-- deploy-key: r2692socialapprovalguard
-- 20261112060206_r2692_social_approval_guard
--
-- R-2692 (12 Nov 2026, from the R-2684 merge review) — two holes in G-SOCIAL:
--
-- 1. The social_content policy is `for all` to owner / manager / marketing, so a MARKETING login
--    could write status = 'approved' (with a scheduled_at) straight into the table and skip the
--    API's rule (api/marketing/social-content/[id]: approve / return / publish need
--    canReviewSocial = owner or manager). The social-publish cron then posted it to the company
--    Page with nobody's approval. Now a BEFORE INSERT / UPDATE / DELETE trigger (SECURITY INVOKER,
--    so it sees who is really writing — public.is_direct_request_login(), R-2485) refuses, for a
--    login that is not owner / manager (current_user_has_role — the same membership check every
--    policy uses):
--      • moving a post to approved / publishing / published, changing or deleting a post that
--        already is;
--      • turning a post 'failed' by hand, or writing reviewed_* / published_* / external_id.
--    Any login's direct INSERT must be a draft or a post sent for review (the app never inserts
--    anything else) and carries no review / publish stamps. When an owner / manager moves a post
--    to approved, reviewed_by / reviewed_at are stamped with THAT login — so reviewed_by on an
--    approved post always names a real approver, and the cron only picks posts that have one.
--    The cron (admin client: service_role / app_service) and SECURITY DEFINER functions are not
--    affected. No repair of older rows: social_content arrives on staging / live in the same
--    train as this file (merge b05915041), so no row there was written through the old hole.
--
-- 2. social-publish and meta-leads-pull are tenant jobs: OFF until a row says on (R-897), and
--    nothing turned them on. Same rule as social-drafts (its own screen switch turns its job on):
--    the act that asks for the job turns it on — approving a post WITH a post time
--    (social-publish), saving chosen lead forms (meta-leads-pull). ensure_social_automation_on()
--    does that, only for these two jobs, and only for the OWNER (R-897: only the owner turns
--    automations on — set_automation_job; social-publish posts to the public Page). For a manager
--    it changes nothing and only says whether the job is on, so the screen can tell them to ask
--    the owner. It never goes over a person's choice: a row an owner switched (changed_by set) is
--    left as it is — an owner who turned it off keeps it off. A row only the cron's run stamp made
--    (enabled = false, changed_by null) counts as "never set". The stamp trigger writes
--    changed_by = this owner and the activity_log line. Returns automation_state(...) = 'on', so
--    practice-run / kill-switch read as off (social-publish has no practice run).
begin;

create or replace function public.tg_social_content_approval_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_locked constant text[] := array['approved', 'publishing', 'published'];
begin
  /* R-2692: only a login's DIRECT write (R-2485's one list: PostgREST request roles and the
     Cloud SQL app_runtime / app_anon / app_jobs logins). The social-publish cron uses the admin
     client (service_role / app_service) and SECURITY DEFINER functions run as their owner — both
     unchanged. */
  if not public.is_direct_request_login() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'review') then
      raise exception 'A new post is saved as a draft or sent for approval. An owner or manager then approves it in Social content.'
        using errcode = '42501';
    end if;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.published_by := null;
    new.published_at := null;
    new.external_id := null;
    return new;
  end if;

  if public.current_user_has_role('owner', 'manager') then
    if tg_op = 'UPDATE' and new.status = 'approved' and old.status is distinct from 'approved' then
      new.reviewed_by := public.current_user_id();
      new.reviewed_at := now();
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if old.status = any (v_locked) then
      raise exception 'An approved or published post can only be removed by an owner or manager. Ask one of them.'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if new.status = any (v_locked) or old.status = any (v_locked) then
    raise exception 'Only an owner or manager can approve, schedule or publish a post. Send it for approval in Social content.'
      using errcode = '42501';
  end if;
  if new.status = 'failed' and old.status is distinct from 'failed' then
    raise exception 'Only a failed publish can mark a post as failed. Save it as a draft instead.'
      using errcode = '42501';
  end if;
  if new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
     or new.published_by is distinct from old.published_by or new.published_at is distinct from old.published_at
     or new.external_id is distinct from old.external_id then
    raise exception 'Only an owner or manager can review or publish a post. Send it for approval in Social content.'
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.tg_social_content_approval_guard() from public, anon, authenticated;

comment on function public.tg_social_content_approval_guard() is
  'R-2692: a login that is not owner / manager cannot approve, schedule or publish a social post by writing the table directly, nor change or delete an approved / published one; any login''s insert is a draft or a post in review; an owner / manager moving a post to approved is stamped as reviewed_by. Admin client (social-publish cron) and SECURITY DEFINER functions are not affected.';

drop trigger if exists trg_social_content_approval_guard on public.social_content;
create trigger trg_social_content_approval_guard
  before insert or update or delete on public.social_content
  for each row execute function public.tg_social_content_approval_guard();

create or replace function public.ensure_social_automation_on(p_job text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row public.automation_jobs;
begin
  /* R-2692: the owner's approve-with-a-time / chosen lead forms turn the job on unless a person
     already chose; a manager only learns whether it is on. True = the job runs live now. */
  if v_tenant is null then
    raise exception 'No company is selected. Sign in again.' using errcode = '28000';
  end if;
  if p_job is null or p_job not in ('social-publish', 'meta-leads-pull') then
    raise exception 'Only scheduled social posts and Facebook lead-form leads are turned on here. Use Automation for other jobs.' using errcode = '22023';
  end if;
  if not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only the owner can turn this on. Ask your owner to turn it on in Automation.' using errcode = '42501';
  end if;

  if public.current_user_has_role('owner') then
    select * into v_row from public.automation_jobs where tenant_id = v_tenant and job = p_job for update;
    if not found then
      insert into public.automation_jobs (tenant_id, job, enabled, dry_run)
      values (v_tenant, p_job, true, false)
      on conflict (tenant_id, job) do nothing;
    elsif v_row.changed_by is null and not v_row.enabled then
      update public.automation_jobs set enabled = true, dry_run = false
       where tenant_id = v_tenant and job = p_job;
    end if;
  end if;
  return public.automation_state(p_job, v_tenant) = 'on';
end
$$;

revoke all on function public.ensure_social_automation_on(text) from public, anon;
grant execute on function public.ensure_social_automation_on(text) to authenticated;

comment on function public.ensure_social_automation_on(text) is
  'R-2692: the OWNER approving a post with a post time (social-publish) or saving chosen lead forms (meta-leads-pull) turns that job on for the company — these two jobs only, never over a switch a person set (changed_by not null). A manager changes nothing. True = automation_state is on.';

commit;
