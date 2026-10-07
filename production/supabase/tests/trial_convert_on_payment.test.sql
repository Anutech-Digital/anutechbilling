-- Regression test (R-282): payment on an accepted quote whose lead is on a quote-trial
-- converts the trial and closes the trial tasks. Self-asserting; rolled back.
--
-- Proves:
--   1. record_payment on an accepted quote (customer already set, lead at stage 'trial')
--      stamps leads.trial_converted_at and moves the lead trial → won.
--   2. The lead's open "Trial…" tasks become 'cancelled'; an unrelated task stays pending.
--   3. A second payment changes nothing (trial_converted_at keeps the first stamp).
-- Fails before migration 20261007010000_trial_convert_on_payment.sql (lead stays 'trial',
-- trial_converted_at null).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('eeeeeeee-0000-0000-0000-000000000282','TRIAL CONV','trial282@example.in','07','TR82');
insert into public.customers (id, tenant_id, name, contact_email)
  values ('cccccccc-0000-0000-0000-000000000282','eeeeeeee-0000-0000-0000-000000000282','Acme Trial','raj@acme-trial.in');
insert into public.leads (id, tenant_id, company, contact_name, contact_email, contact_phone, stage, source, priority,
                          customer_id, trial_started_at, trial_expires_at)
  values ('L-TR-282','eeeeeeee-0000-0000-0000-000000000282','Acme Trial','Raj','raj@acme-trial.in','+919800000282','trial','manual','medium',
          'cccccccc-0000-0000-0000-000000000282', now() - interval '3 days', now() + interval '11 days');
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-TR-282','eeeeeeee-0000-0000-0000-000000000282','L-TR-282','cccccccc-0000-0000-0000-000000000282','Acme Trial',
          38232,32400,18,'accepted','awaiting',
          '[{"name":"Google Workspace Starter","qty":10,"rate":3240,"commitment":"annual_yearly"}]'::jsonb);
insert into public.tasks (tenant_id, title, kind, due_at, lead_id, quote_id, status) values
  ('eeeeeeee-0000-0000-0000-000000000282','Trial setup: DNS and 10 users · Acme Trial','custom', now(), 'L-TR-282',null,'done'),
  ('eeeeeeee-0000-0000-0000-000000000282','Trial: send payment link · Acme Trial','followup', now() + interval '7 days', 'L-TR-282',null,'pending'),
  ('eeeeeeee-0000-0000-0000-000000000282','Trial ends today: extend, stop or convert · Acme Trial','followup', now() + interval '11 days', 'L-TR-282',null,'pending'),
  ('eeeeeeee-0000-0000-0000-000000000282','Call about renewal','call', now() + interval '2 days', 'L-TR-282',null,'pending');

do $$
declare
  v_stage text; v_conv timestamptz; v_conv2 timestamptz; v_open int; v_cancelled int; v_other text; v_done text;
begin
  perform public.record_payment('Q-TR-282', 20000, 'bank_transfer', 'TR282-REF-1');

  select stage::text, trial_converted_at into v_stage, v_conv from public.leads where id = 'L-TR-282';
  if v_conv is null then raise exception 'FAIL: trial_converted_at not set after payment'; end if;
  if v_stage <> 'won' then raise exception 'FAIL: lead stage expected won, got %', v_stage; end if;

  select count(*) filter (where status = 'pending'), count(*) filter (where status = 'cancelled')
    into v_open, v_cancelled
    from public.tasks where lead_id = 'L-TR-282' and title like 'Trial%';
  if v_open <> 0 then raise exception 'FAIL: % trial tasks still pending', v_open; end if;
  if v_cancelled <> 2 then raise exception 'FAIL: expected 2 cancelled trial tasks, got %', v_cancelled; end if;

  select status::text into v_done from public.tasks where lead_id = 'L-TR-282' and title like 'Trial setup%';
  if v_done <> 'done' then raise exception 'FAIL: finished setup task rewritten to %', v_done; end if;
  select status::text into v_other from public.tasks where lead_id = 'L-TR-282' and title = 'Call about renewal';
  if v_other <> 'pending' then raise exception 'FAIL: unrelated task changed to %', v_other; end if;

  -- second payment (the balance): nothing moves
  perform pg_sleep(0.01);
  perform public.record_payment('Q-TR-282', 18232, 'upi', 'TR282-REF-2');
  select trial_converted_at into v_conv2 from public.leads where id = 'L-TR-282';
  if v_conv2 <> v_conv then raise exception 'FAIL: trial_converted_at re-stamped (% → %)', v_conv, v_conv2; end if;

  raise notice 'PASS trial-convert-on-payment: lead trial→won + converted, 2 trial tasks cancelled, others untouched, idempotent';
end $$;
rollback;
