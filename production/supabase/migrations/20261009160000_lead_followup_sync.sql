-- deploy-key: leadfollowup
-- deploy-peek: exists(select 1 from pg_trigger where tgname='trg_leads_won_close_tasks') and exists(select 1 from pg_trigger where tgname='trg_tasks_lead_follow_up')
-- 20261009160000_lead_followup_sync
--
-- R-483 (R-444 part 5, R-459, R-470 point 6 — Abhishek's audit, 8-9 Oct 2026):
--   (a) A deal went Won and paid, but its follow-up task "Call Amit… quote" stayed open and
--       the lead kept its follow-up date — Today / Tasks kept nagging about a closed sale.
--       Now: the moment a lead becomes Won, its open (pending / snoozed) tasks are marked
--       done and follow_up_date is cleared. Every path to Won (record_payment, the board,
--       an edit) goes through this one trigger, so none can forget.
--   (b) Adding a follow-up task to a lead did not set the lead's follow_up_date, so the list
--       and the call queue (which read follow_up_date) never saw it. Now a new open task on
--       an open lead moves follow_up_date to the task's IST day when that day is sooner than
--       the date already there (or the old date is empty / in the past).
--
-- Both functions are SECURITY INVOKER: they only touch rows of the lead being written, which
-- the writer's RLS already allows. Explicit EXECUTE grants (Cloud SQL gives no PUBLIC default,
-- R-401). Never to anon.

create or replace function public.tg_leads_won_close_tasks()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.stage = 'won' and old.stage is distinct from 'won' then
    new.follow_up_date := null;
    update public.tasks
       set status = 'done'
     where lead_id = new.id
       and status in ('pending', 'snoozed');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_leads_won_close_tasks on public.leads;
create trigger trg_leads_won_close_tasks
  before update of stage on public.leads
  for each row execute function public.tg_leads_won_close_tasks();

create or replace function public.tg_tasks_lead_follow_up()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_day   date := (new.due_at at time zone 'Asia/Kolkata')::date;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if new.lead_id is null or new.status not in ('pending', 'snoozed') then
    return new;
  end if;
  update public.leads l
     set follow_up_date = v_day
   where l.id = new.lead_id
     and l.stage not in ('won', 'lost')
     and (l.follow_up_date is null or l.follow_up_date < v_today or l.follow_up_date > v_day);
  return new;
end;
$$;

drop trigger if exists trg_tasks_lead_follow_up on public.tasks;
create trigger trg_tasks_lead_follow_up
  after insert on public.tasks
  for each row execute function public.tg_tasks_lead_follow_up();

revoke all on function public.tg_leads_won_close_tasks() from public, anon;
revoke all on function public.tg_tasks_lead_follow_up() from public, anon;
grant execute on function public.tg_leads_won_close_tasks() to authenticated, service_role;
grant execute on function public.tg_tasks_lead_follow_up() to authenticated, service_role;

-- One-time tidy for leads ALREADY won with open tasks (Sharma / Singh in local data).
update public.tasks t
   set status = 'done'
  from public.leads l
 where t.lead_id = l.id
   and l.stage = 'won'
   and t.status in ('pending', 'snoozed')
   and t.created_at <= coalesce(l.stage_changed_at, l.updated_at);  -- pre-sale tasks only
