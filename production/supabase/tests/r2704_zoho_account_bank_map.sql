-- R-2704: save_zoho_account_bank_choice — the FY Zoho import dialogs remember Zoho account → app account,
-- per company. Owner / accountant only; another company's / closed account refused; 'none' = Leave out;
-- '' forgets; one row per company + use + key; a login cannot write the table directly.
-- Self-asserting; the whole file rolls back.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < this file

begin;

insert into auth.users (id, email) values
  ('b2704000-0000-0000-0000-0000000000a1', 'r2704-owner@example.test'),
  ('b2704000-0000-0000-0000-0000000000a2', 'r2704-acct@example.test'),
  ('b2704000-0000-0000-0000-0000000000a3', 'r2704-mgr@example.test'),
  ('b2704000-0000-0000-0000-0000000000a9', 'r2704-other@example.test');

insert into public.tenants (id, name, email, state_code, gstin, doc_code) values
  ('b2704000-0000-0000-0000-0000000000f0', 'R2704 T', 'r2704@example.test', '07', null, 'R2704'),
  ('b2704000-0000-0000-0000-0000000000f1', 'R2704 O', 'r2704o@example.test', '07', null, 'R2704O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2704000-0000-0000-0000-0000000000a1', 'b2704000-0000-0000-0000-0000000000f0', 'r2704-owner@example.test', 'Owner', 'owner', true),
  ('b2704000-0000-0000-0000-0000000000a2', 'b2704000-0000-0000-0000-0000000000f0', 'r2704-acct@example.test', 'Acct', 'accountant', true),
  ('b2704000-0000-0000-0000-0000000000a3', 'b2704000-0000-0000-0000-0000000000f0', 'r2704-mgr@example.test', 'Mgr', 'manager', true),
  ('b2704000-0000-0000-0000-0000000000a9', 'b2704000-0000-0000-0000-0000000000f1', 'r2704-other@example.test', 'Other', 'owner', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type) values
  ('b2704000-0000-0000-0000-0000000000e1', 'b2704000-0000-0000-0000-0000000000f0', 'HDFC 4523', 'HDFC', 'current'),
  ('b2704000-0000-0000-0000-0000000000e2', 'b2704000-0000-0000-0000-0000000000f0', 'R2704 Closed', 'HDFC', 'current'),
  ('b2704000-0000-0000-0000-0000000000e3', 'b2704000-0000-0000-0000-0000000000f0', 'R2704 Inactive', 'HDFC', 'current'),
  ('b2704000-0000-0000-0000-0000000000e4', 'b2704000-0000-0000-0000-0000000000f0', 'R2704 Card', 'HDFC', 'credit_card'),
  ('b2704000-0000-0000-0000-0000000000e9', 'b2704000-0000-0000-0000-0000000000f1', 'Other Co Bank', 'ICICI', 'current');
update public.bank_accounts set closed_on = '2025-01-01' where id = 'b2704000-0000-0000-0000-0000000000e2';
update public.bank_accounts set is_active = false where id = 'b2704000-0000-0000-0000-0000000000e3';

do $$
begin
  if to_regprocedure('public.save_zoho_account_bank_choice(text,text,text)') is null then
    raise exception 'FAIL 0: save_zoho_account_bank_choice missing';
  end if;
  if has_function_privilege('anon', 'public.save_zoho_account_bank_choice(text,text,text)', 'execute')
     or has_table_privilege('authenticated', 'public.zoho_account_bank_map', 'insert')
     or has_table_privilege('authenticated', 'public.zoho_account_bank_map', 'update') then
    raise exception 'FAIL 0b: anon can call it, or a login can write the table directly';
  end if;
end $$;

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.refused(p_who uuid, p_use text, p_key text, p_choice text, p_code text) returns boolean language plpgsql as $f$
begin
  perform pg_temp.as_user(p_who);
  perform public.save_zoho_account_bank_choice(p_use, p_key, p_choice);
  return false;
exception when others then
  if sqlstate = p_code then return true; end if;
  raise exception 'wrong refusal: % %', sqlstate, sqlerrm;
end $f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.refused(uuid, text, text, text, text) to authenticated;
set local role authenticated;

do $$
declare r jsonb; m public.zoho_account_bank_map; n int;
begin
  -- 1. Roles + bad input.
  if not pg_temp.refused('b2704000-0000-0000-0000-0000000000a3', 'receipts', 'Z-1', 'b2704000-0000-0000-0000-0000000000e1', '42501') then raise exception 'FAIL 1: manager saved'; end if;
  if not pg_temp.refused('b2704000-0000-0000-0000-0000000000a2', 'other', 'Z-1', 'none', '22023') then raise exception 'FAIL 1b: unknown use'; end if;
  if not pg_temp.refused('b2704000-0000-0000-0000-0000000000a2', 'receipts', '  ', 'none', '22023') then raise exception 'FAIL 1c: blank key'; end if;
  if not pg_temp.refused('b2704000-0000-0000-0000-0000000000a2', 'receipts', 'Z-1', 'b2704000-0000-0000-0000-0000000000e9', '22023') then raise exception 'FAIL 1d: other company account'; end if;
  if not pg_temp.refused('b2704000-0000-0000-0000-0000000000a2', 'receipts', 'Z-1', 'b2704000-0000-0000-0000-0000000000e2', '22023') then raise exception 'FAIL 1e: closed account'; end if;
  if not pg_temp.refused('b2704000-0000-0000-0000-0000000000a2', 'receipts', 'Z-1', 'not-a-uuid', '22023') then raise exception 'FAIL 1f: junk choice'; end if;
  if not pg_temp.refused('b2704000-0000-0000-0000-0000000000a2', 'receipts', 'Z-1', 'b2704000-0000-0000-0000-0000000000e3', '22023') then raise exception 'FAIL 1g: inactive account'; end if;
  if not pg_temp.refused('b2704000-0000-0000-0000-0000000000a2', 'receipts', 'Z-1', 'b2704000-0000-0000-0000-0000000000e4', '22023') then raise exception 'FAIL 1h: receipts on a card'; end if;

  -- 2. Accountant saves a receipts choice; saving again replaces it (one row).
  perform pg_temp.as_user('b2704000-0000-0000-0000-0000000000a2');
  r := public.save_zoho_account_bank_choice('receipts', 'Z-1', 'b2704000-0000-0000-0000-0000000000e1');
  if (r->>'saved')::boolean is not true then raise exception 'FAIL 2: %', r; end if;
  perform public.save_zoho_account_bank_choice('receipts', 'Z-1', 'none');
  select count(*) into n from public.zoho_account_bank_map where tenant_id = 'b2704000-0000-0000-0000-0000000000f0';
  select * into m from public.zoho_account_bank_map where tenant_id = 'b2704000-0000-0000-0000-0000000000f0' and use_for = 'receipts' and zoho_key = 'Z-1';
  if n <> 1 or m.leave_out is not true or m.bank_account_id is not null then raise exception 'FAIL 2b: % rows, %', n, row_to_json(m); end if;

  -- 3. Purchases keyed by name, separate from receipts with the same key.
  perform public.save_zoho_account_bank_choice('purchases', 'Z-1', 'b2704000-0000-0000-0000-0000000000e1');
  perform public.save_zoho_account_bank_choice('purchases', 'M/S. Main Bank Co', 'b2704000-0000-0000-0000-0000000000e4');  -- a card may pay purchases
  select count(*) into n from public.zoho_account_bank_map where tenant_id = 'b2704000-0000-0000-0000-0000000000f0';
  if n <> 3 then raise exception 'FAIL 3: % rows', n; end if;

  -- 4. '' forgets.
  r := public.save_zoho_account_bank_choice('purchases', 'Z-1', '');
  if (r->>'cleared')::boolean is not true
     or exists (select 1 from public.zoho_account_bank_map where tenant_id = 'b2704000-0000-0000-0000-0000000000f0' and use_for = 'purchases' and zoho_key = 'Z-1') then
    raise exception 'FAIL 4: not forgotten %', r;
  end if;

  -- 5. RLS: the other company sees none of these rows.
  perform pg_temp.as_user('b2704000-0000-0000-0000-0000000000a9');
  select count(*) into n from public.zoho_account_bank_map;
  if n <> 0 then raise exception 'FAIL 5: other company sees % rows', n; end if;
  perform pg_temp.as_user('b2704000-0000-0000-0000-0000000000a1');
  select count(*) into n from public.zoho_account_bank_map;
  if n <> 2 then raise exception 'FAIL 5b: owner sees % rows', n; end if;
end $$;

rollback;
