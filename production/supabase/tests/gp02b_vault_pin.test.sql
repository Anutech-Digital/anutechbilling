-- R-2112 / GP-02b — Private Vault PIN hardening (migration 20261030042132_gp02b_vault_pin_hardening.sql).
--
-- WHAT THIS PROVES
--   1. A signed-in owner can still READ their own PIN row (the GET status needs it).
--   2. The owner can NOT write it from the browser: UPDATE failed_attempts / locked_until,
--      INSERT a fresh row or DELETE it are refused, and the row is unchanged afterwards.
--      Before GP-02b the FOR ALL policy let anyone with devtools reset their own lockout.
--   3. The owner can NOT call the PIN RPCs directly (service role only) — otherwise
--      vault_pin_clear_attempts() would be the same reset in another shape.
--   4. vault_pin_begin_attempt() counts the attempt in ONE statement before the PIN is
--      checked: five calls give 1..5, the fifth closes the lock, a sixth is refused while
--      locked and does not count, and an expired lock lets one more attempt through which
--      re-closes it at once.
--   5. vault_pin_clear_attempts() wipes the slate; vault_pin_save(..., false) never replaces
--      an existing PIN; vault_pin_remove() deletes it; 'none' when there is no PIN.
--
-- SAFETY: synthetic identities in a synthetic tenant, one transaction, ends in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('d2b2d2b2-0000-0000-0000-0000000000a1', 'gp02b-owner@example.test');

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('d2b2d2b2-0000-0000-0000-0000000000f0', 'GP02B T', 'gp02b@example.test', '07', 'GP2B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('d2b2d2b2-0000-0000-0000-0000000000a1', 'd2b2d2b2-0000-0000-0000-0000000000f0',
   'gp02b-owner@example.test', 'GP02B Owner', 'owner', true);

insert into public.personal_vault_pin (user_id, tenant_id, pin_hash, pin_salt, failed_attempts, locked_until) values
  ('d2b2d2b2-0000-0000-0000-0000000000a1', 'd2b2d2b2-0000-0000-0000-0000000000f0', 'hash0', 'salt0', 4, now() + interval '10 minutes');

-- ─── As the signed-in owner (a real browser token arrives as `authenticated`) ───────────
set local role authenticated;

do $$
declare
  v_a uuid := 'd2b2d2b2-0000-0000-0000-0000000000a1';
  n int;
  v_failed int;
  v_refused boolean;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_a, 'role', 'authenticated')::text, true);

  -- 1. own row readable
  select count(*) into n from public.personal_vault_pin where user_id = v_a;
  if n <> 1 then raise exception 'gp02b FAIL 1: owner cannot read own PIN row (n=%)', n; end if;

  -- 2a. UPDATE the counter / lock → refused (error or 0 rows), row unchanged
  begin
    update public.personal_vault_pin set failed_attempts = 0, locked_until = null where user_id = v_a;
  exception when others then null;
  end;
  select failed_attempts into v_failed from public.personal_vault_pin where user_id = v_a;
  if v_failed <> 4 then
    raise exception 'gp02b FAIL 2a: authenticated UPDATE reset failed_attempts to % (must stay 4)', v_failed;
  end if;
  select count(*) into n from public.personal_vault_pin where user_id = v_a and locked_until is not null;
  if n <> 1 then raise exception 'gp02b FAIL 2a: authenticated UPDATE cleared locked_until'; end if;

  -- 2b. DELETE → refused, row still there
  begin
    delete from public.personal_vault_pin where user_id = v_a;
  exception when others then null;
  end;
  select count(*) into n from public.personal_vault_pin where user_id = v_a;
  if n <> 1 then raise exception 'gp02b FAIL 2b: authenticated DELETE removed the PIN row'; end if;

  -- 2c. INSERT → refused (any error is the refusal)
  v_refused := false;
  begin
    insert into public.personal_vault_pin (user_id, tenant_id, pin_hash, pin_salt)
      values (v_a, 'd2b2d2b2-0000-0000-0000-0000000000f0', 'x', 'y')
      on conflict (user_id) do update set pin_hash = 'hijacked', failed_attempts = 0;
  exception when others then v_refused := true;
  end;
  select count(*) into n from public.personal_vault_pin where user_id = v_a and pin_hash = 'hash0';
  if not v_refused or n <> 1 then raise exception 'gp02b FAIL 2c: authenticated INSERT/upsert was not refused'; end if;

  -- 3. PIN RPCs are service-role only
  v_refused := false;
  begin perform public.vault_pin_clear_attempts(v_a);
  exception when others then v_refused := true; end;
  if not v_refused then raise exception 'gp02b FAIL 3: authenticated could call vault_pin_clear_attempts'; end if;

  v_refused := false;
  begin perform * from public.vault_pin_begin_attempt(v_a);
  exception when others then v_refused := true; end;
  if not v_refused then raise exception 'gp02b FAIL 3: authenticated could call vault_pin_begin_attempt'; end if;

  v_refused := false;
  begin perform public.vault_pin_save(v_a, 'd2b2d2b2-0000-0000-0000-0000000000f0', 'h', 's', true);
  exception when others then v_refused := true; end;
  if not v_refused then raise exception 'gp02b FAIL 3: authenticated could call vault_pin_save'; end if;

  v_refused := false;
  begin perform public.vault_pin_remove(v_a);
  exception when others then v_refused := true; end;
  if not v_refused then raise exception 'gp02b FAIL 3: authenticated could call vault_pin_remove'; end if;
end $$;

-- ─── As the server (the route's admin client) ───────────────────────────────────────────
reset role;
set local role service_role;

do $$
declare
  v_a uuid := 'd2b2d2b2-0000-0000-0000-0000000000a1';
  v_t uuid := 'd2b2d2b2-0000-0000-0000-0000000000f0';
  r record;
  i int;
  v_saved boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  -- 4a. locked row → 'locked', counter NOT moved
  select * into r from public.vault_pin_begin_attempt(v_a);
  if r.status <> 'locked' or r.failed_attempts <> 4 then
    raise exception 'gp02b FAIL 4a: locked row gave status=% failed=%', r.status, r.failed_attempts;
  end if;
  if r.pin_hash is not null then raise exception 'gp02b FAIL 4a: hash handed out while locked'; end if;

  -- 5a. clear → 0 / null
  perform public.vault_pin_clear_attempts(v_a);
  select failed_attempts, locked_until into r from public.personal_vault_pin where user_id = v_a;
  if r.failed_attempts <> 0 or r.locked_until is not null then
    raise exception 'gp02b FAIL 5a: clear left failed=% locked_until=%', r.failed_attempts, r.locked_until;
  end if;

  -- 4b. five attempts count 1..5; the fifth closes the lock
  for i in 1..5 loop
    select * into r from public.vault_pin_begin_attempt(v_a);
    if r.status <> 'ok' or r.failed_attempts <> i or r.pin_hash <> 'hash0' or r.pin_salt <> 'salt0' then
      raise exception 'gp02b FAIL 4b: attempt % gave status=% failed=%', i, r.status, r.failed_attempts;
    end if;
    if i < 5 and r.locked_until is not null then raise exception 'gp02b FAIL 4b: locked early at %', i; end if;
    if i = 5 and (r.locked_until is null or r.locked_until < now() + interval '14 minutes') then
      raise exception 'gp02b FAIL 4b: fifth attempt did not lock for 15 minutes (locked_until=%)', r.locked_until;
    end if;
  end loop;

  -- 4c. sixth while locked → refused, not counted
  select * into r from public.vault_pin_begin_attempt(v_a);
  if r.status <> 'locked' or r.failed_attempts <> 5 then
    raise exception 'gp02b FAIL 4c: sixth attempt gave status=% failed=%', r.status, r.failed_attempts;
  end if;

  -- 4d. lock expired → exactly one more attempt, which re-closes it
  update public.personal_vault_pin set locked_until = now() - interval '1 second' where user_id = v_a;
  select * into r from public.vault_pin_begin_attempt(v_a);
  if r.status <> 'ok' or r.failed_attempts <> 6 or r.locked_until is null or r.locked_until <= now() then
    raise exception 'gp02b FAIL 4d: after expiry gave status=% failed=% locked_until=%', r.status, r.failed_attempts, r.locked_until;
  end if;

  -- 5b. save without replace never overwrites an existing PIN
  select public.vault_pin_save(v_a, v_t, 'newhash', 'newsalt', false) into v_saved;
  if v_saved then raise exception 'gp02b FAIL 5b: save(replace=false) overwrote an existing PIN'; end if;
  if not exists (select 1 from public.personal_vault_pin where user_id = v_a and pin_hash = 'hash0') then
    raise exception 'gp02b FAIL 5b: PIN changed';
  end if;

  -- 5c. save with replace → new hash, slate wiped
  select public.vault_pin_save(v_a, v_t, 'newhash', 'newsalt', true) into v_saved;
  select * into r from public.personal_vault_pin where user_id = v_a;
  if not v_saved or r.pin_hash <> 'newhash' or r.failed_attempts <> 0 or r.locked_until is not null then
    raise exception 'gp02b FAIL 5c: replace gave saved=% hash=% failed=%', v_saved, r.pin_hash, r.failed_attempts;
  end if;

  -- 5d. save for a tenant the user is not in → refused
  begin
    perform public.vault_pin_save(v_a, gen_random_uuid(), 'h', 's', true);
    raise exception 'gp02b FAIL 5d: save accepted a foreign tenant';
  exception when others then
    if sqlerrm like 'gp02b FAIL%' then raise; end if;
  end;

  -- 5e. remove → gone; begin_attempt says 'none'
  perform public.vault_pin_remove(v_a);
  select * into r from public.vault_pin_begin_attempt(v_a);
  if r.status <> 'none' then raise exception 'gp02b FAIL 5e: after remove status=%', r.status; end if;

  -- 5f. first save (replace=false) on an empty slot works
  select public.vault_pin_save(v_a, v_t, 'h1', 's1', false) into v_saved;
  if not v_saved then raise exception 'gp02b FAIL 5f: first save refused'; end if;

  raise notice 'gp02b_vault_pin: all checks passed';
end $$;

rollback;
