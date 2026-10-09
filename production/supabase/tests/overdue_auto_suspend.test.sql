-- R-116 (20261007281600): automatic pause is undone when its invoice is settled; a manual
-- pause is not; write-off drafts need >180 days overdue and only the owner decides them.
-- Rolled back; safe anywhere. Exit 0 = pass.
begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('cccccccc-0000-0000-0000-000000116000', 'R116 A', 'r116-a@example.in', '07'),
  ('cccccccc-0000-0000-0000-000000116100', 'R116 B', 'r116-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('cccccccc-0000-0000-0000-000000116001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r116-owner@example.in'),
  ('cccccccc-0000-0000-0000-000000116002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r116-rep@example.in'),
  ('cccccccc-0000-0000-0000-000000116101', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r116-b-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('cccccccc-0000-0000-0000-000000116001', 'cccccccc-0000-0000-0000-000000116000', 'r116-owner@example.in', 'owner'),
  ('cccccccc-0000-0000-0000-000000116002', 'cccccccc-0000-0000-0000-000000116000', 'r116-rep@example.in', 'sales'),
  ('cccccccc-0000-0000-0000-000000116101', 'cccccccc-0000-0000-0000-000000116100', 'r116-b-owner@example.in', 'owner');

insert into public.invoices (id, tenant_id, customer_name, amount, status, due_date) values
  ('INV-R116-AUTO',   'cccccccc-0000-0000-0000-000000116000', 'Auto Co',   10000, 'overdue', current_date - 20),
  ('INV-R116-MANUAL', 'cccccccc-0000-0000-0000-000000116000', 'Manual Co',  5000, 'overdue', current_date - 20),
  ('INV-R116-OLD',    'cccccccc-0000-0000-0000-000000116000', 'Old Co',     8000, 'overdue', current_date - 200),
  ('INV-R116-YOUNG',  'cccccccc-0000-0000-0000-000000116000', 'Young Co',   8000, 'overdue', current_date - 100);

insert into public.subscriptions (id, tenant_id, customer_name, plan, vendor, seats, mrr, status,
                                  suspended_at, suspended_by, suspend_reason, suspended_invoice_id) values
  ('cccccccc-0000-0000-0000-0000001160a1', 'cccccccc-0000-0000-0000-000000116000', 'Auto Co', 'Business Starter', 'google', 5, 1350,
   'paused', now(), 'automation', 'Invoice INV-R116-AUTO is 20 days overdue.', 'INV-R116-AUTO'),
  ('cccccccc-0000-0000-0000-0000001160a2', 'cccccccc-0000-0000-0000-000000116000', 'Manual Co', 'Business Starter', 'google', 5, 1350,
   'paused', now(), 'user', 'Owner paused it.', 'INV-R116-MANUAL');

do $$ declare s text; n int; begin
  -- 1. A part payment leaves the automatic pause in place.
  update public.invoices set paid_amount = 4000 where id = 'INV-R116-AUTO';
  select status::text into s from public.subscriptions where id = 'cccccccc-0000-0000-0000-0000001160a1';
  if s <> 'paused' then raise exception 'FAIL 1: part payment resumed the service (%)', s; end if;

  -- 2. A credit note style reduction to zero (net_payable = paid) resumes it, with a record.
  update public.invoices set net_payable = 4000 where id = 'INV-R116-AUTO';
  select status::text into s from public.subscriptions where id = 'cccccccc-0000-0000-0000-0000001160a1';
  if s <> 'active' then raise exception 'FAIL 2: settled invoice did not resume the service (%)', s; end if;
  if exists (select 1 from public.subscriptions where id = 'cccccccc-0000-0000-0000-0000001160a1'
             and (suspended_at is not null or suspended_by is not null or suspended_invoice_id is not null)) then
    raise exception 'FAIL 2b: pause fields not cleared';
  end if;
  select count(*) into n from public.ai_action_log
   where entity_id = 'cccccccc-0000-0000-0000-0000001160a1' and action = 'subscription.overdue_resume' and outcome = 'did';
  if n <> 1 then raise exception 'FAIL 2c: expected 1 resume log row, got %', n; end if;

  -- 3. A pause made by a person is never undone by payment.
  update public.invoices set status = 'paid' where id = 'INV-R116-MANUAL';
  select status::text into s from public.subscriptions where id = 'cccccccc-0000-0000-0000-0000001160a2';
  if s <> 'paused' then raise exception 'FAIL 3: manual pause was undone (%)', s; end if;
  raise notice 'PASS 1-3: resume trigger';
end $$;

set local role authenticated;

do $$ declare v_id uuid; v_err boolean; s text; begin
  -- 4. A rep may suggest a write-off for a >180-day invoice; it is a draft.
  perform set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-000000116002', 'role', 'authenticated')::text, true);
  v_id := public.suggest_invoice_write_off('INV-R116-OLD');
  select status into s from public.invoice_write_off_drafts where id = v_id;
  if s <> 'draft' then raise exception 'FAIL 4: suggestion is not a draft (%)', s; end if;
  if public.suggest_invoice_write_off('INV-R116-OLD') <> v_id then raise exception 'FAIL 4b: second suggestion made a second draft'; end if;

  -- 5. Under 180 days is refused.
  v_err := false;
  begin perform public.suggest_invoice_write_off('INV-R116-YOUNG'); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 5: 100-day invoice was suggested for write-off'; end if;

  -- 6. The rep cannot confirm.
  v_err := false;
  begin perform public.decide_invoice_write_off(v_id, 'confirmed'); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 6: a sales rep confirmed a write-off'; end if;

  -- 7. Another company's owner cannot see or decide it.
  perform set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-000000116101', 'role', 'authenticated')::text, true);
  if exists (select 1 from public.invoice_write_off_drafts where id = v_id) then raise exception 'FAIL 7: other tenant sees the draft'; end if;
  v_err := false;
  begin perform public.decide_invoice_write_off(v_id, 'confirmed'); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 7b: other tenant decided the draft'; end if;
  v_err := false;
  begin perform public.suggest_invoice_write_off('INV-R116-OLD'); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 7c: other tenant suggested a write-off on our invoice'; end if;

  -- 8. The owner confirms.
  perform set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-000000116001', 'role', 'authenticated')::text, true);
  perform public.decide_invoice_write_off(v_id, 'confirmed');
  select status into s from public.invoice_write_off_drafts where id = v_id;
  if s <> 'confirmed' then raise exception 'FAIL 8: owner confirm did not stick (%)', s; end if;

  -- 9. The table cannot be written directly.
  v_err := false;
  begin
    insert into public.invoice_write_off_drafts (tenant_id, invoice_id, amount, days_overdue, reason)
    values ('cccccccc-0000-0000-0000-000000116000', 'INV-R116-YOUNG', 1, 1, 'x');
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 9: direct insert into invoice_write_off_drafts was allowed'; end if;
  raise notice 'PASS 4-9: write-off drafts';
end $$;

rollback;
