-- deploy-peek: exists(select 1 from pg_constraint where conname = 'ai_telecall_logs_provider_check' and conrelid = to_regclass('public.ai_telecall_logs') and pg_get_constraintdef(oid) like '%bolna%')
-- deploy-key: r1437bolna
-- prisma/migrations/20261014110000_r1437_telecall_provider_bolna
-- R-1437 (Abhishek, 14 Oct 2026): Bolna (bolna.ai) becomes the third telecalling vendor next to
-- Retell and Vapi — Indian numbers and Hinglish voices on one account. `ai_telecall_logs.provider`
-- is CHECKed to the vendors the app knows (20260825120000_ai_telecalling.sql), so a queued Bolna
-- call could not be written until 'bolna' is in that list. Additive only: every existing row
-- ('retell' / 'vapi' / 'none') still passes.
begin;

alter table public.ai_telecall_logs
  drop constraint if exists ai_telecall_logs_provider_check;

alter table public.ai_telecall_logs
  add constraint ai_telecall_logs_provider_check
  check (provider in ('retell', 'vapi', 'bolna', 'none'));

commit;
