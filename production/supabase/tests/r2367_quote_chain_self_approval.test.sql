-- R-2367 (2 Nov 2026): nobody who made or revised a quote family may approve it — on the SERVER.
-- Staging 2 Nov: the app refused approving your own new below-cost quote, but after Revise the
-- -R2 copies (Q-A378-27-0565-R2..0567-R2, 0880-R2) were approved by the same person: a revision
-- starts with no approval record, and approving was a plain browser update with no server rule.
-- Migration 20261102121211_r2367_quote_chain_self_approval (quotes.created_by,
-- quote_chain_makers(), trigger trg_quote_approval_not_by_maker).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. A manager's own new quote (asked approval himself) — his approve is refused by the server.
--   B. Owner's real path: he Revises it (-R2, no approval record) and approves the -R2 → refused.
--   C. Writing someone else's id in approved_by does not help — still refused.
--   D. Chain-aware: an owner who revised the family (-R3) cannot approve -R3, nor -R2 (made by
--      the manager), and the manager cannot approve -R3 either.
--   E. Another approver (owner who touched nothing) approves -R3 → allowed, and approved_by is
--      always the signer's own id even when the client sends another.
--   F. A path with no login (service / cron) is unchanged.
--   G. quote_chain_makers() is tenant-scoped for a login.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000236701','R2367 Co','r2367@example.in','07','R2367'),
  ('dddddddd-0000-0000-0000-000000236702','R2367 Other','r2367b@example.in','07','R2367B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000236701','mgr2367@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000236702','own2367a@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000236703','own2367b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000236704','other2367@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000236701','dddddddd-0000-0000-0000-000000236701','mgr2367@example.in','Manager 2367','manager', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000236702','dddddddd-0000-0000-0000-000000236701','own2367a@example.in','Owner A 2367','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000236703','dddddddd-0000-0000-0000-000000236701','own2367b@example.in','Owner B 2367','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000236704','dddddddd-0000-0000-0000-000000236702','other2367@example.in','Other 2367','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000236701','dddddddd-0000-0000-0000-000000236701','Varal 2367','07','varal2367.in');

-- The manager makes a below-cost quote (sent) and asks approval himself.
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000236701","role":"authenticated"}', true);
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, payment_status, billing_cycle, line_items, is_one_off,
                           created_date, approval_status, approval_tier, approval_requested_by, approval_requested_at,
                           created_by)
values ('Q-R2367-0565','dddddddd-0000-0000-0000-000000236701','cccccccc-0000-0000-0000-000000236701','Varal 2367',
        'Google Workspace Business Standard', 3, 1770, 1500, 1800, 0, 18, 'sent', 'awaiting', 'yearly',
        '[{"id":"l1","name":"Google Workspace Business Standard","qty":3,"rate":500,"cost":600,"commitment":"annual_yearly"}]'::jsonb,
        false, '2026-11-02', 'pending', 'owner', 'aaaaaaaa-0000-0000-0000-000000236701', now(),
        'aaaaaaaa-0000-0000-0000-000000236703');  -- a client-sent created_by is ignored: the login wins

do $$
begin
  if (select created_by from public.quotes where id = 'Q-R2367-0565') is distinct from 'aaaaaaaa-0000-0000-0000-000000236701'::uuid then
    raise exception 'FAIL setup: created_by is not the login';
  end if;
  raise notice 'PASS setup: created_by = the login, not what the client sent';
end $$;

-- A. own new quote: refused on the server
do $$
declare v_msg text;
begin
  begin
    update public.quotes set approval_status = 'approved', approved_by = 'aaaaaaaa-0000-0000-0000-000000236701', approved_at = now()
     where id = 'Q-R2367-0565';
    raise exception 'FAIL A: manager approved his own quote';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'You cannot approve Q-R2367-0565 — you made, revised or asked approval for this quote%' then
      raise exception 'FAIL A: wrong refusal: %', v_msg;
    end if;
  end;
  raise notice 'PASS A: own quote refused by the server';
end $$;

-- B. Revise → -R2 (draft, no approval record, as revise.ts inserts it) → approve own -R2: refused
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                           revision_of, revision_no)
values ('Q-R2367-0565-R2','dddddddd-0000-0000-0000-000000236701','cccccccc-0000-0000-0000-000000236701','Varal 2367',
        'Google Workspace Business Standard', 3, 1770, 1500, 1800, 0, 18, 'draft', 'yearly',
        '[{"id":"l1","name":"Google Workspace Business Standard","qty":3,"rate":500,"cost":600,"commitment":"annual_yearly"}]'::jsonb,
        false, '2026-11-02', 'Q-R2367-0565', 2);

do $$
declare v_msg text;
begin
  begin
    update public.quotes set approval_status = 'approved', approved_by = 'aaaaaaaa-0000-0000-0000-000000236701', approved_at = now()
     where id = 'Q-R2367-0565-R2';
    raise exception 'FAIL B: same user approved the revised -R2';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'You cannot approve Q-R2367-0565-R2 —%' then raise exception 'FAIL B: wrong refusal: %', v_msg; end if;
  end;
  if (select approval_status::text from public.quotes where id = 'Q-R2367-0565-R2') <> 'not_required' then
    raise exception 'FAIL B: -R2 approval status changed';
  end if;
  raise notice 'PASS B: revise then self-approve refused';
end $$;

-- C. naming someone else in approved_by does not help
do $$
declare v_msg text;
begin
  begin
    update public.quotes set approval_status = 'approved', approved_by = 'aaaaaaaa-0000-0000-0000-000000236703', approved_at = now()
     where id = 'Q-R2367-0565-R2';
    raise exception 'FAIL C: approved in another person''s name';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'You cannot approve Q-R2367-0565-R2 —%' then raise exception 'FAIL C: wrong refusal: %', v_msg; end if;
  end;
  raise notice 'PASS C: approved_by cannot be forged';
end $$;

-- D. Owner A revises the family (-R3): chain-aware refusals
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000236702","role":"authenticated"}', true);
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                           revision_of, revision_no)
values ('Q-R2367-0565-R3','dddddddd-0000-0000-0000-000000236701','cccccccc-0000-0000-0000-000000236701','Varal 2367',
        'Google Workspace Business Standard', 3, 1770, 1500, 1800, 0, 18, 'draft', 'yearly',
        '[{"id":"l1","name":"Google Workspace Business Standard","qty":3,"rate":500,"cost":600,"commitment":"annual_yearly"}]'::jsonb,
        false, '2026-11-02', 'Q-R2367-0565', 3);

do $$
declare v_msg text; v_id text;
begin
  foreach v_id in array array['Q-R2367-0565-R3', 'Q-R2367-0565-R2', 'Q-R2367-0565'] loop
    begin
      update public.quotes set approval_status = 'approved', approved_by = 'aaaaaaaa-0000-0000-0000-000000236702', approved_at = now()
       where id = v_id;
      raise exception 'FAIL D: owner A (reviser) approved %', v_id;
    exception when others then
      v_msg := sqlerrm;
      if v_msg like 'FAIL%' then raise; end if;
      if v_msg not like 'You cannot approve ' || v_id || ' —%' then raise exception 'FAIL D: wrong refusal on %: %', v_id, v_msg; end if;
    end;
  end loop;
  raise notice 'PASS D1: the owner who revised cannot approve any quote of the family';
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000236701","role":"authenticated"}', true);
do $$
declare v_msg text;
begin
  begin
    update public.quotes set approval_status = 'approved', approved_at = now() where id = 'Q-R2367-0565-R3';
    raise exception 'FAIL D: the manager approved the -R3 another person revised from his quote';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'You cannot approve Q-R2367-0565-R3 —%' then raise exception 'FAIL D2: wrong refusal: %', v_msg; end if;
  end;
  raise notice 'PASS D2: the first maker cannot approve a later revision either';
end $$;

-- E. Owner B (touched nothing) approves -R3 → allowed; approved_by is B whatever the client sent
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000236703","role":"authenticated"}', true);
update public.quotes set approval_status = 'approved', approved_by = 'aaaaaaaa-0000-0000-0000-000000236701', approved_at = now(),
       approved_margin_bps = -2000, approved_discount_bps = 0
 where id = 'Q-R2367-0565-R3';
do $$
begin
  if (select approval_status::text from public.quotes where id = 'Q-R2367-0565-R3') <> 'approved' then
    raise exception 'FAIL E: another approver could not approve';
  end if;
  if (select approved_by from public.quotes where id = 'Q-R2367-0565-R3') <> 'aaaaaaaa-0000-0000-0000-000000236703'::uuid then
    raise exception 'FAIL E: approved_by is not the signer';
  end if;
  raise notice 'PASS E: another approver approves, in their own name';
end $$;

-- G. tenant scope of quote_chain_makers for a login of another tenant
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000236704","role":"authenticated"}', true);
do $$
begin
  if cardinality(public.quote_chain_makers('Q-R2367-0565-R2')) <> 0 then
    raise exception 'FAIL G: another tenant read the makers';
  end if;
  raise notice 'PASS G: makers are tenant-scoped';
end $$;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000236703","role":"authenticated"}', true);
do $$
declare v uuid[];
begin
  v := public.quote_chain_makers('Q-R2367-0565-R2');
  if not (v @> array['aaaaaaaa-0000-0000-0000-000000236701','aaaaaaaa-0000-0000-0000-000000236702']::uuid[])
     or 'aaaaaaaa-0000-0000-0000-000000236703'::uuid = any (v) then
    raise exception 'FAIL G: wrong makers %', v;
  end if;
  raise notice 'PASS G2: makers = manager + reviser, not the approver';
end $$;

-- F. no login (service / cron path) is unchanged
select set_config('request.jwt.claims', '', true);
update public.quotes set approval_status = 'approved', approved_by = 'aaaaaaaa-0000-0000-0000-000000236701', approved_at = now()
 where id = 'Q-R2367-0565-R2';
do $$
begin
  if (select approved_by from public.quotes where id = 'Q-R2367-0565-R2') <> 'aaaaaaaa-0000-0000-0000-000000236701'::uuid then
    raise exception 'FAIL F: service path changed';
  end if;
  raise notice 'PASS F: no-login path unchanged';
end $$;

rollback;
