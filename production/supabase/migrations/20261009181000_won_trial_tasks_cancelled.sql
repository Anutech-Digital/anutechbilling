-- deploy-peek: exists(select 1 from pg_proc where proname='tg_leads_won_close_tasks' and prosrc like '%R-496%')
-- deploy-key: wontrialtasks
-- 20261009181000_won_trial_tasks_cancelled
--
-- R-496: `node scripts/test-sql.mjs --local` went 135/136 on 9 Oct — trial_convert_on_payment
-- failed with "expected 2 cancelled trial tasks, got 0".
--
-- Cause: two triggers now act on the same tasks when a paid trial lead becomes Won.
--   * R-282 (20261007010000) — fn_trial_convert_on_payment, AFTER INSERT on payments: sets the
--     lead trial → won, THEN cancels the lead's open "Trial…" tasks.
--   * R-483 (20261009160000) — tg_leads_won_close_tasks, BEFORE UPDATE OF stage on leads: the
--     moment a lead becomes Won, marks ALL its open tasks 'done'.
-- R-282's lead update fires R-483 first, so "Trial: send payment link" and "Trial ends today"
-- were stamped 'done' — and R-282's cancel then found nothing open. The same happens on every
-- other path to Won (record_payment branch 2, the board, an edit).
--
-- 'done' is wrong for those two: nobody sent a payment link or ran a trial-end review — the
-- trial was paid, so the reminders were called off. Reports and the task history read 'done'
-- as "work performed". So when the lead had a trial, its open "Trial…" tasks become
-- 'cancelled'; every other open task still becomes 'done' exactly as R-483 intended.
-- Also scoped to the lead's tenant (lead ids are per-tenant text ids).
--
-- Proved by supabase/tests/trial_convert_on_payment.test.sql (2 trial tasks cancelled, the
-- lead's other open task done, another lead's task untouched).

create or replace function public.tg_leads_won_close_tasks()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- R-483 + R-496: Won closes open tasks; a paid trial's "Trial…" reminders are cancelled, not done.
  if new.stage = 'won' and old.stage is distinct from 'won' then
    new.follow_up_date := null;
    update public.tasks
       set status = case
                      when new.trial_started_at is not null and title like 'Trial%' then 'cancelled'::public.task_status
                      else 'done'::public.task_status
                    end
     where lead_id = new.id
       and tenant_id = new.tenant_id
       and status in ('pending', 'snoozed');
  end if;
  return new;
end;
$$;

revoke all on function public.tg_leads_won_close_tasks() from public, anon;
grant execute on function public.tg_leads_won_close_tasks() to authenticated, service_role;
