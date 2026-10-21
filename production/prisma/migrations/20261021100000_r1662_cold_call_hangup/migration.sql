-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cold_call_contacts' and column_name = 'hangup_reason')
-- deploy-key: r1662coldhangup
-- prisma/migrations/20261021100000_r1662_cold_call_hangup
-- R-1662 (Abhishek, 21 Oct 2026): show WHY a number was not reached — busy, cut the call,
-- did not pick up — not just "waiting". The phone network's own words come back from Bolna
-- (telephony_data.hangup_reason / hangup_by); kept on the row as the last try's reason.
begin;

alter table public.cold_call_contacts
  add column if not exists hangup_reason text check (hangup_reason is null or length(hangup_reason) <= 300),
  add column if not exists hangup_by text check (hangup_by is null or length(hangup_by) <= 40);

commit;
