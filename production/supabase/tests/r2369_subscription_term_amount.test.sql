-- R-2369 (2 Nov 2026, staging reconcile): a subscription's yearly amount drifted from the sold
--   price because only a whole-rupee mrr was stored (₹1,300/yr → mrr 108 → ₹1,296; 5 × ₹850 →
--   mrr 355 → ₹4,260). Migration 20261102123706_r2369_subscription_term_amount keeps the exact
--   term amount in subscriptions.term_amount. Self-asserting, ONE transaction, rolled back.
--
--   A. 5 × ₹850/yr line, filed with mrr 355 (per-seat rounding) → term_amount ₹4,250.00.
--   B. 1 × ₹1,300/yr line, mrr 108 → term_amount ₹1,300.00.
--   C. Monthly flex line 10 × ₹270/mo, mrr 2,700, term 1 → term_amount ₹2,700.00 (unchanged figure).
--   D. A line that is not this row's price (hand-set mrr ₹500) → NULL (mrr wins, as before).
--   E. No quote → NULL.
--   F. +1 seat on A (mrr 426) → ₹5,100.00 (per seat ₹850 kept).
--   G. Price change on B (mrr 120, same seats) → NULL (mrr wins).
--   H. Renewal paid on B' (renewal quote subtotal ₹1,300, mrr round(1300/12) = 108) → ₹1,300.00.
--   I. Back-fill: a row with term_amount NULL and a matching line gets it; running again is a no-op.

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
  ('dddddddd-0000-0000-0000-000000236901','R2369 Term Co','r2369@example.in','07','R69T');
insert into public.customers (id, tenant_id, name) values
  ('cccccccc-0000-4000-8000-000000236901','dddddddd-0000-0000-0000-000000236901','Term Customer');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, line_items) values
  ('Q-R2369-SALE','dddddddd-0000-0000-0000-000000236901','cccccccc-0000-4000-8000-000000236901','Term Customer', 7552, 6400,
   jsonb_build_array(
     jsonb_build_object('name','ResWeb Email','qty',5,'rate',850,'commitment','annual_yearly'),
     jsonb_build_object('name','example.in domain','qty',1,'rate',1300,'commitment','annual_yearly'),
     jsonb_build_object('name','Flex Mail','qty',10,'rate',270,'commitment','monthly'),
     jsonb_build_object('name','Odd Plan','qty',2,'rate',1000,'commitment','annual_yearly'))),
  ('Q-R2369-REN','dddddddd-0000-0000-0000-000000236901','cccccccc-0000-4000-8000-000000236901','Term Customer', 1534, 1300,
   jsonb_build_array(jsonb_build_object('name','second.in domain','qty',1,'rate',1300,'commitment','annual_yearly')));

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months,
                                  status, start_date, renewal_date, quote_id) values
  ('eeeeeeee-0000-4000-8000-000000236901','dddddddd-0000-0000-0000-000000236901','cccccccc-0000-4000-8000-000000236901','Term Customer',
   'ResWeb Email','other',5,355,12,'active','2026-11-02','2027-11-01','Q-R2369-SALE'),
  ('eeeeeeee-0000-4000-8000-000000236902','dddddddd-0000-0000-0000-000000236901','cccccccc-0000-4000-8000-000000236901','Term Customer',
   'example.in domain','other',1,108,12,'active','2026-11-02','2027-11-01','Q-R2369-SALE'),
  ('eeeeeeee-0000-4000-8000-000000236903','dddddddd-0000-0000-0000-000000236901','cccccccc-0000-4000-8000-000000236901','Term Customer',
   'Flex Mail','other',10,2700,1,'active','2026-11-02','2026-12-01','Q-R2369-SALE'),
  ('eeeeeeee-0000-4000-8000-000000236904','dddddddd-0000-0000-0000-000000236901','cccccccc-0000-4000-8000-000000236901','Term Customer',
   'Odd Plan','other',2,500,12,'active','2026-11-02','2027-11-01','Q-R2369-SALE'),
  ('eeeeeeee-0000-4000-8000-000000236905','dddddddd-0000-0000-0000-000000236901','cccccccc-0000-4000-8000-000000236901','Term Customer',
   'No Quote Plan','other',3,250,12,'active','2026-11-02','2027-11-01',null),
  ('eeeeeeee-0000-4000-8000-000000236906','dddddddd-0000-0000-0000-000000236901','cccccccc-0000-4000-8000-000000236901','Term Customer',
   'second.in domain','other',1,120,12,'active','2025-11-02','2026-11-01',null);

do $$
declare
  v numeric;
begin
  select term_amount into v from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000236901';
  if v is distinct from 4250.00 then raise exception 'FAIL A: 5 x 850 term_amount = % (want 4250.00)', v; end if;

  select term_amount into v from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000236902';
  if v is distinct from 1300.00 then raise exception 'FAIL B: 1,300 term_amount = % (want 1300.00)', v; end if;

  select term_amount into v from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000236903';
  if v is distinct from 2700.00 then raise exception 'FAIL C: monthly flex term_amount = % (want 2700.00)', v; end if;

  select term_amount into v from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000236904';
  if v is not null then raise exception 'FAIL D: hand-set mrr row got term_amount % (want NULL)', v; end if;

  select term_amount into v from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000236905';
  if v is not null then raise exception 'FAIL E: no-quote row got term_amount % (want NULL)', v; end if;
end $$;

-- F. +1 seat (mrrForSeats: round(355 × 6 / 5) = 426).
update public.subscriptions set seats = 6, mrr = 426 where id = 'eeeeeeee-0000-4000-8000-000000236901';
-- G. A real price change on B: same seats, mrr ₹120.
update public.subscriptions set mrr = 120 where id = 'eeeeeeee-0000-4000-8000-000000236902';
-- H. Renewal paid: record_payment clears renewal_quote_id, rolls the date, mrr = round(1300 / 12).
update public.subscriptions set renewal_quote_id = 'Q-R2369-REN' where id = 'eeeeeeee-0000-4000-8000-000000236906';
update public.subscriptions
   set renewal_quote_id = null, renewal_date = '2027-11-01', mrr = 108
 where id = 'eeeeeeee-0000-4000-8000-000000236906';

do $$
declare
  v numeric;
begin
  select term_amount into v from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000236901';
  if v is distinct from 5100.00 then raise exception 'FAIL F: 6 seats term_amount = % (want 5100.00)', v; end if;

  select term_amount into v from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000236902';
  if v is not null then raise exception 'FAIL G: price change kept term_amount % (want NULL)', v; end if;

  select term_amount into v from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000236906';
  if v is distinct from 1300.00 then raise exception 'FAIL H: renewal term_amount = % (want 1300.00)', v; end if;
end $$;

-- I. Back-fill is idempotent and only fills from a matching line.
update public.subscriptions set term_amount = null where id = 'eeeeeeee-0000-4000-8000-000000236903';
update public.subscriptions s
   set term_amount = public.subscription_term_amount_from_quote(s.tenant_id, s.quote_id, s.plan, s.seats, s.term_months, s.mrr)
 where s.tenant_id = 'dddddddd-0000-0000-0000-000000236901'
   and s.term_amount is null and s.quote_id is not null
   and public.subscription_term_amount_from_quote(s.tenant_id, s.quote_id, s.plan, s.seats, s.term_months, s.mrr) is not null;
do $$
declare
  v numeric; n int;
begin
  select term_amount into v from public.subscriptions where id = 'eeeeeeee-0000-4000-8000-000000236903';
  if v is distinct from 2700.00 then raise exception 'FAIL I: back-fill gave % (want 2700.00)', v; end if;
  select count(*) into n from public.subscriptions s
   where s.tenant_id = 'dddddddd-0000-0000-0000-000000236901'
     and s.term_amount is null and s.quote_id is not null
     and public.subscription_term_amount_from_quote(s.tenant_id, s.quote_id, s.plan, s.seats, s.term_months, s.mrr) is not null;
  if n <> 0 then raise exception 'FAIL I: back-fill not idempotent, % rows still fillable', n; end if;
end $$;

select 'R-2369 subscription term_amount: all checks passed' as result;

rollback;
