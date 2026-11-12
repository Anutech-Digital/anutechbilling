-- R-2653: "Read from Zoho again" keeps the FY scan and reads only new / changed documents. The scan
-- remembers Zoho's last_modified_time (zoho_modified) and a payment's deposit account; the run
-- remembers when this listing began (list_started_at) and its deposit-account filter
-- (only_account_id). Server only (service_role); other roles see nothing (R-2499 RLS unchanged).
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('b2653000-0000-0000-0000-0000000000f0', 'R2653 T', 'r2653@example.test', '07', 'R2653'),
  ('b2653000-0000-0000-0000-0000000000f1', 'R2653 O', 'r2653o@example.test', '07', 'R2653O');

-- 1. The new columns hold what the server writes.
insert into public.zoho_fy_scan_runs (tenant_id, kind, fy, next_page, list_done, list_started_at, only_account_id)
values ('b2653000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 1, false, '2026-11-10T06:00:00Z', 'ZA-RZP');
insert into public.zoho_fy_scan (tenant_id, kind, fy, zoho_id, number, doc_date, zoho_status, payload, listed_at, detailed_at, zoho_modified, deposit_account_id) values
  ('b2653000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'p-1', 'PAY-1', '2025-06-01', 'paid', '{"number":"PAY-1"}', '2026-11-10T06:01:00Z', '2026-11-09T06:00:00Z', '2025-06-01T10:00:00+0530', 'ZA-RZP'),
  ('b2653000-0000-0000-0000-0000000000f0', 'customerpayments', '2025-26', 'p-2', 'PAY-2', '2025-06-02', 'paid', '{"number":"PAY-2"}', '2026-11-09T06:00:00Z', '2026-11-09T06:00:00Z', null, 'ZA-HDFC'),
  ('b2653000-0000-0000-0000-0000000000f1', 'customerpayments', '2025-26', 'p-9', 'PAY-9', '2025-06-02', 'paid', '{"number":"PAY-9"}', '2026-11-09T06:00:00Z', '2026-11-09T06:00:00Z', null, null);

do $$
begin
  if (select only_account_id from public.zoho_fy_scan_runs where tenant_id = 'b2653000-0000-0000-0000-0000000000f0' and kind = 'customerpayments' and fy = '2025-26') <> 'ZA-RZP' then
    raise exception 'R2653: only_account_id not stored';
  end if;
  if (select zoho_modified from public.zoho_fy_scan where tenant_id = 'b2653000-0000-0000-0000-0000000000f0' and zoho_id = 'p-1') <> '2025-06-01T10:00:00+0530' then
    raise exception 'R2653: zoho_modified not stored';
  end if;
end $$;

-- 2. Too long a value is refused (the server cuts at 60).
do $$
begin
  begin
    update public.zoho_fy_scan set zoho_modified = repeat('x', 61) where zoho_id = 'p-1';
    raise exception 'R2653: a 61-char zoho_modified was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.zoho_fy_scan set facts_version = -1 where zoho_id = 'p-1';
    raise exception 'R2653: a negative facts_version was accepted';
  exception when check_violation then null;
  end;
  update public.zoho_fy_scan set facts_version = 1 where zoho_id = 'p-1';
end $$;

-- 3. The requeue the server runs after a complete list (payload := null where listed_at < list_started_at)
--    touches only THIS company's + list's + FY's rows not listed since — never another company's.
update public.zoho_fy_scan set payload = null, detailed_at = null
 where tenant_id = 'b2653000-0000-0000-0000-0000000000f0' and kind = 'customerpayments' and fy = '2025-26'
   and listed_at < '2026-11-10T06:00:00Z';
do $$
begin
  if (select payload from public.zoho_fy_scan where zoho_id = 'p-2') is not null then raise exception 'R2653: p-2 not requeued'; end if;
  if (select payload from public.zoho_fy_scan where zoho_id = 'p-1') is null then raise exception 'R2653: p-1 requeued by mistake'; end if;
  if (select payload from public.zoho_fy_scan where zoho_id = 'p-9') is null then raise exception 'R2653: other company''s row requeued'; end if;
end $$;

-- 4. Server only: a signed-in user reads nothing of the scan (R-2499 RLS + grants unchanged).
set local role authenticated;
do $$
declare n int;
begin
  begin
    select count(*) into n from public.zoho_fy_scan;
    if n > 0 then raise exception 'R2653: authenticated sees % scan rows', n; end if;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$ begin raise notice 'R2653 zoho scan modified: all checks passed'; end $$;

rollback;
