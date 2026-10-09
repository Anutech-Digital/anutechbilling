-- Regression test: accepting a quote closes only ITS family's older versions
-- (migration 20261009191000_quote_accept_family_only, board R-495 — Pardeep's decision 2B).
-- Run on a dev/test DB. Self-asserting; rolled back.
--
-- One lead, two products:
--   Q-QF-0001     Workspace R1, sent 3 days ago
--   Q-QF-0001-R2  Workspace R2 (revision_of Q-QF-0001)
--   Q-QF-0002     Hosting quote, sent 4 days ago (older than both) — a different product
--
-- Proves:
--   A. R2 sent → R1 replaced (R-482 send trigger, unchanged); hosting still sent.
--   B. R2 accepted → R1 closed, hosting STILL sent (before R-495 it was closed as
--      "replaced by" the Workspace quote); lead seats/value follow R2.
--   C. Draft R2 accepted straight away (no send step) → the accept trigger itself closes
--      R1 (viewed) and leaves the hosting quote open.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('eeeeeeee-0000-0000-0000-0000000004f5','QF TEST','qf@example.in','07','QFT5');
insert into public.leads (id, tenant_id, company, stage, source, priority, seats, value)
  values ('L-QF-1','eeeeeeee-0000-0000-0000-0000000004f5','Kapoor Co','quote','manual','medium',15,36000),
         ('L-QF-2','eeeeeeee-0000-0000-0000-0000000004f5','Sethi Co','quote','manual','medium',10,24000);
insert into public.quotes (id, tenant_id, lead_id, customer_name, amount, subtotal, seats, tax_rate, status, payment_status, created_at)
  values ('Q-QF-0002','eeeeeeee-0000-0000-0000-0000000004f5','L-QF-1','Kapoor Co',3540,3000,1,18,'sent','none', now() - interval '4 day'),
         ('Q-QF-0001','eeeeeeee-0000-0000-0000-0000000004f5','L-QF-1','Kapoor Co',42480,36000,15,18,'sent','none', now() - interval '3 day'),
         ('Q-QF-0012','eeeeeeee-0000-0000-0000-0000000004f5','L-QF-2','Sethi Co',3540,3000,1,18,'sent','none', now() - interval '4 day'),
         ('Q-QF-0011','eeeeeeee-0000-0000-0000-0000000004f5','L-QF-2','Sethi Co',28320,24000,10,18,'viewed','none', now() - interval '3 day');
insert into public.quotes (id, tenant_id, lead_id, customer_name, amount, subtotal, seats, tax_rate, status, payment_status, revision_of, revision_no)
  values ('Q-QF-0001-R2','eeeeeeee-0000-0000-0000-0000000004f5','L-QF-1','Kapoor Co',33984,28800,12,18,'draft','none','Q-QF-0001',2),
         ('Q-QF-0011-R2','eeeeeeee-0000-0000-0000-0000000004f5','L-QF-2','Sethi Co',22656,19200,8,18,'draft','none','Q-QF-0011',2);

do $$
declare v_status text; v_by text; v_seats int; v_value int;
begin
  -- A. send R2
  update public.quotes set status = 'sent' where id = 'Q-QF-0001-R2';
  select status::text, superseded_by into v_status, v_by from public.quotes where id = 'Q-QF-0001';
  if v_status <> 'expired' or v_by is distinct from 'Q-QF-0001-R2' then raise exception 'FAIL A1: R1 not replaced on send (% / %)', v_status, v_by; end if;
  select status::text, superseded_by into v_status, v_by from public.quotes where id = 'Q-QF-0002';
  if v_status <> 'sent' or v_by is not null then raise exception 'FAIL A2: hosting quote touched on send (% / %)', v_status, v_by; end if;

  -- B. accept R2
  update public.quotes set status = 'accepted' where id = 'Q-QF-0001-R2';
  select status::text, superseded_by into v_status, v_by from public.quotes where id = 'Q-QF-0001';
  if v_status <> 'expired' or v_by is distinct from 'Q-QF-0001-R2' then raise exception 'FAIL B1: R1 not closed (% / %)', v_status, v_by; end if;
  select status::text, superseded_by into v_status, v_by from public.quotes where id = 'Q-QF-0002';
  if v_status <> 'sent' or v_by is not null then raise exception 'FAIL B2: hosting quote closed by the Workspace accept (% / %)', v_status, v_by; end if;
  select seats, value into v_seats, v_value from public.leads where id = 'L-QF-1';
  if v_seats <> 12 or v_value <> 28800 then raise exception 'FAIL B3: lead is % seats / ₹%', v_seats, v_value; end if;

  -- C. draft R2 accepted directly — only the accept trigger can close R1
  update public.quotes set status = 'accepted' where id = 'Q-QF-0011-R2';
  select status::text, superseded_by into v_status, v_by from public.quotes where id = 'Q-QF-0011';
  if v_status <> 'expired' or v_by is distinct from 'Q-QF-0011-R2' then raise exception 'FAIL C1: R1 not closed by accept (% / %)', v_status, v_by; end if;
  select status::text, superseded_by into v_status, v_by from public.quotes where id = 'Q-QF-0012';
  if v_status <> 'sent' or v_by is not null then raise exception 'FAIL C2: other product quote closed (% / %)', v_status, v_by; end if;

  raise notice 'PASS quote_accept_family_only';
end $$;
rollback;
