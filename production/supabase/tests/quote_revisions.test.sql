-- Regression test: quote revisions (migration 20261009120000, board R-448 / R-482).
-- Run on a dev/test DB. Self-asserting; rolled back.
--
-- Proves:
--   1. A revision saved as DRAFT replaces nothing (the customer has not seen it).
--   2. When the revision is sent, the old sent quote becomes 'expired' + superseded_by.
--   3. The replaced quote can never be accepted again.
--   4. Accepting the revision sets the lead's seats/value from it (ex-GST subtotal).
--   5. Accepting closes the lead's OLDER open quotes too (deal won).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('eeeeeeee-0000-0000-0000-0000000000c7','QR TEST','qr@example.in','07','QRT7');
insert into public.leads (id, tenant_id, company, stage, source, priority, seats, value)
  values ('L-QR-1','eeeeeeee-0000-0000-0000-0000000000c7','Mehta Co','quote','manual','medium',15,48600);
insert into public.quotes (id, tenant_id, lead_id, customer_name, amount, subtotal, seats, tax_rate, status, payment_status, created_at)
  values ('Q-QR-0005','eeeeeeee-0000-0000-0000-0000000000c7','L-QR-1','Mehta Co',57348,48600,15,18,'sent','none', now() - interval '2 day'),
         ('Q-QR-0004','eeeeeeee-0000-0000-0000-0000000000c7','L-QR-1','Mehta Co',1180,1000,1,18,'sent','none', now() - interval '3 day');
insert into public.quotes (id, tenant_id, lead_id, customer_name, amount, subtotal, seats, tax_rate, status, payment_status, revision_of, revision_no)
  values ('Q-QR-0005-R2','eeeeeeee-0000-0000-0000-0000000000c7','L-QR-1','Mehta Co',45878,38880,12,18,'draft','none','Q-QR-0005',2);

do $$
declare v_status text; v_by text; v_seats int; v_value int;
begin
  select status::text, superseded_by into v_status, v_by from public.quotes where id = 'Q-QR-0005';
  if v_status <> 'sent' or v_by is not null then raise exception 'FAIL 1: draft revision replaced the old quote (% / %)', v_status, v_by; end if;

  update public.quotes set status = 'sent' where id = 'Q-QR-0005-R2';
  select status::text, superseded_by into v_status, v_by from public.quotes where id = 'Q-QR-0005';
  if v_status <> 'expired' or v_by is distinct from 'Q-QR-0005-R2' then raise exception 'FAIL 2: old quote not replaced (% / %)', v_status, v_by; end if;

  begin
    update public.quotes set status = 'accepted' where id = 'Q-QR-0005';
    raise exception 'FAIL 3: replaced quote was accepted';
  exception when check_violation then null;
  end;

  update public.quotes set status = 'accepted' where id = 'Q-QR-0005-R2';
  select seats, value into v_seats, v_value from public.leads where id = 'L-QR-1';
  if v_seats <> 12 or v_value <> 38880 then raise exception 'FAIL 4: lead is % seats / ₹%', v_seats, v_value; end if;

  select status::text, superseded_by into v_status, v_by from public.quotes where id = 'Q-QR-0004';
  if v_status <> 'expired' or v_by is distinct from 'Q-QR-0005-R2' then raise exception 'FAIL 5: older open quote still open (% / %)', v_status, v_by; end if;

  raise notice 'PASS quote_revisions';
end $$;
rollback;
