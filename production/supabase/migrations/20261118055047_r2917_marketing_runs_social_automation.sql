-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.set_social_automation(text,boolean)')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.ensure_social_automation_on(text)') and prosrc like '%R-2917%')
-- deploy-key: r2917marketingrunssocialautomation
-- 20261118055047_r2917_marketing_runs_social_automation
--
-- R-2917 (18 Nov 2026, Abhishek): "give these rights to marketing person also, only budget approval
-- rights have owner". The marketing person runs Social growth end to end, including the company
-- jobs that make it run by itself:
--   • social-drafts    — the Monday AI plan (Social growth → AI agent → Posts, Save AI settings)
--   • social-publish   — posts approved posts at their time
--   • meta-leads-pull  — Facebook lead-form leads
-- Every other automation (renewal emails, reminders, crons that message customers) stays the
-- owner's switch on /automation (R-897, set_automation_job unchanged).
--
-- 1. set_social_automation(job, enabled): owner, manager or marketing switch ONE of those three jobs
--    on or off. SECURITY DEFINER because automation_jobs writes are owner-only by RLS (R-897); the
--    function checks the role itself and touches only these three jobs of the caller's company.
--    changed_by is stamped by the existing R-897 trigger (auth.uid()).
-- 2. ensure_social_automation_on(job): the approve-with-a-time / chosen-lead-forms act now turns
--    the job on for owner, manager AND marketing (was owner only), still never over a switch a
--    person set (changed_by not null), and now also takes social-drafts.
begin;

create or replace function public.set_social_automation(p_job text, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  /* R-2917 */
  if v_tenant is null then
    raise exception 'No company is selected. Sign in again.' using errcode = '28000';
  end if;
  if p_job is null or p_job not in ('social-drafts', 'social-publish', 'meta-leads-pull') then
    raise exception 'Only the Social growth jobs are switched here. Use Automation for other jobs.' using errcode = '22023';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'marketing') then
    raise exception 'Only the owner, a manager or marketing can switch this. Ask one of them.' using errcode = '42501';
  end if;
  insert into public.automation_jobs (tenant_id, job, enabled, dry_run)
  values (v_tenant, p_job, coalesce(p_enabled, false), false)
  on conflict (tenant_id, job) do update
    set enabled = excluded.enabled,
        dry_run = false;
  return public.automation_state(p_job, v_tenant) = 'on';
end
$$;
revoke all on function public.set_social_automation(text, boolean) from public, anon;
grant execute on function public.set_social_automation(text, boolean) to authenticated;

comment on function public.set_social_automation(text, boolean) is
  'R-2917: owner, manager or marketing switch one Social growth job (social-drafts, social-publish, meta-leads-pull) on or off for their own company. Other automations stay owner-only (R-897).';

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
  /* R-2692, R-2917: the owner's, a manager's or marketing's approve-with-a-time / chosen lead forms
     turn the job on unless a person already chose. True = the job runs live now. */
  if v_tenant is null then
    raise exception 'No company is selected. Sign in again.' using errcode = '28000';
  end if;
  if p_job is null or p_job not in ('social-drafts', 'social-publish', 'meta-leads-pull') then
    raise exception 'Only the Social growth jobs are turned on here. Use Automation for other jobs.' using errcode = '22023';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'marketing') then
    raise exception 'Only the owner, a manager or marketing can turn this on.' using errcode = '42501';
  end if;

  select * into v_row from public.automation_jobs where tenant_id = v_tenant and job = p_job for update;
  if not found then
    insert into public.automation_jobs (tenant_id, job, enabled, dry_run)
    values (v_tenant, p_job, true, false)
    on conflict (tenant_id, job) do nothing;
  elsif v_row.changed_by is null and not v_row.enabled then
    update public.automation_jobs set enabled = true, dry_run = false
     where tenant_id = v_tenant and job = p_job;
  end if;
  return public.automation_state(p_job, v_tenant) = 'on';
end
$$;
revoke all on function public.ensure_social_automation_on(text) from public, anon;
grant execute on function public.ensure_social_automation_on(text) to authenticated;

comment on function public.ensure_social_automation_on(text) is
  'R-2692 / R-2917: the owner, a manager or marketing approving a post with a post time (social-publish), saving chosen lead forms (meta-leads-pull) or the weekly AI plan (social-drafts) turns that job on for the company — never over a switch a person set (changed_by not null). True = automation_state is on.';

commit;
