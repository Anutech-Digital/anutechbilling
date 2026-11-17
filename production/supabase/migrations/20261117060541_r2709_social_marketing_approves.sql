-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_social_content_approval_guard()') and prosrc like '%R-2709%')
-- deploy-key: r2709socialmarketingapproves
-- 20261117060541_r2709_social_marketing_approves
--
-- R-2709 (12 Nov 2026, Abhishek) made the MARKETING person the one who approves the AI's social
-- posts, and a person's own "Schedule post" goes straight to approved (owner and manager may too).
-- R-2692 (Pardeep, same week) put a guard on social_content that lets only owner / manager
-- approve, and refuses ANY direct insert that is not a draft / review. Both reached
-- manager-pardeep; merged on 16 Nov 2026 the guard would refuse:
--   • the marketing person approving an AI post (the R-2709 job of that role);
--   • every "Schedule post" and every AI-autopilot post — those INSERT with status approved, and
--     the guard checked the insert before the role, so even the owner was refused.
-- Abhishek chose (16 Nov 2026): marketing approves. This file keeps every R-2692 protection and
-- only widens WHO is a reviewer:
--   • reviewer = owner, manager or marketing (the same three canReviewSocial allows in the app);
--   • a reviewer may INSERT an approved post; reviewed_by / reviewed_at are stamped with that
--     login, so the cron's "reviewed_by is not null" still names a real person;
--   • nobody inserts publishing / published / failed, nor carries publish stamps or a forged
--     reviewer on an insert;
--   • a login that is not a reviewer (no such role can write social_content today — the policy is
--     owner / manager / marketing — but kept fail-closed) gets the old R-2692 refusals.
-- The cron (admin client) and SECURITY DEFINER functions are not affected, as before.
-- ensure_social_automation_on is NOT changed: only the owner turns the job on (R-897).
begin;

create or replace function public.tg_social_content_approval_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_locked constant text[] := array['approved', 'publishing', 'published'];
  v_reviewer boolean;
begin
  /* R-2692: only a login's DIRECT write. Cron (service_role / app_service) and SECURITY DEFINER
     functions pass unchanged. */
  if not public.is_direct_request_login() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  /* R-2709: the marketing person reviews too (owner / manager may). */
  v_reviewer := public.current_user_has_role('owner', 'manager', 'marketing');

  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'review') and not (v_reviewer and new.status = 'approved') then
      raise exception 'A new post is saved as a draft, sent for approval, or scheduled by the marketing team.'
        using errcode = '42501';
    end if;
    new.published_by := null;
    new.published_at := null;
    new.external_id := null;
    if new.status = 'approved' then
      new.reviewed_by := public.current_user_id();
      new.reviewed_at := now();
    else
      new.reviewed_by := null;
      new.reviewed_at := null;
    end if;
    return new;
  end if;

  if v_reviewer then
    if tg_op = 'UPDATE' and new.status = 'approved' and old.status is distinct from 'approved' then
      new.reviewed_by := public.current_user_id();
      new.reviewed_at := now();
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if old.status = any (v_locked) then
      raise exception 'An approved or published post can only be removed by the marketing team. Ask one of them.'
        using errcode = '42501';
    end if;
    return old;
  end if;
  if new.status = any (v_locked) or old.status = any (v_locked) then
    raise exception 'Only the marketing team can approve, schedule or publish a post. Send it for approval in Social content.'
      using errcode = '42501';
  end if;
  if new.status = 'failed' and old.status is distinct from 'failed' then
    raise exception 'Only a failed publish can mark a post as failed. Save it as a draft instead.'
      using errcode = '42501';
  end if;
  if new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
     or new.published_by is distinct from old.published_by or new.published_at is distinct from old.published_at
     or new.external_id is distinct from old.external_id then
    raise exception 'Only the marketing team can review or publish a post. Send it for approval in Social content.'
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.tg_social_content_approval_guard() from public, anon, authenticated;

comment on function public.tg_social_content_approval_guard() is
  'R-2692 + R-2709: reviewers are owner / manager / marketing. A reviewer may insert or move a post to approved and is stamped as reviewed_by; nobody inserts publishing / published / failed or publish stamps. Any other login gets the R-2692 refusals. Admin client (social-publish cron) and SECURITY DEFINER functions are not affected.';

commit;
