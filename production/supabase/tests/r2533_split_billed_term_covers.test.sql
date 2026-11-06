-- R-2533 (6 Nov 2026): a split-billed subscription's renewal date must cover one whole term from
-- its start date. Suresh Kumar & Co shape (staging sub 52a285c1): start 19 Jun 2026, renewal
-- 19 Dec 2026, term 12 months, half-yearly → the schedule counted the term back to 20 Dec 2025
-- and part #1 was invoiced six months before the sale.
-- Migration 20261106132256_r2533_split_billed_term_covers.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. inserting the Suresh shape is refused with a message naming the earliest renewal date
--      (red without the migration: the insert goes through).
--   B. valid first-term rows pass: inclusive last day (18 Jun 2027) and anniversary (19 Jun 2027).
--   C. a renewed row (start years ago) passes.
--   D. not split-billed → untouched: yearly with a short renewal; monthly on a 1-month term.
--   E. editing a valid split-billed row to the Suresh shape is refused (also by changing the cycle).
--   F. an existing bad row (made before the guard) still takes other edits (status, seats), and
--      its repair to a full-term renewal date goes through.
--   G. cancelling a split-billed row mid-term (renewal_date = last day of service) still works.

begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('25330000-0000-4000-8000-000000000001', 'R2533 TEST', 'r2533@example.in', '07', 'R2533');
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('25330000-0000-4000-8000-0000000000c1', '25330000-0000-4000-8000-000000000001', 'R2533 Customer', '07', 'India');


-- A. the Suresh shape is refused.
do $$
declare v_msg text;
begin
  begin
    insert into public.subscriptions
      (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle, start_date, renewal_date)
    values ('25330000-0000-4000-8000-0000000000a1', '25330000-0000-4000-8000-000000000001', '25330000-0000-4000-8000-0000000000c1',
            'R2533 Customer', 'Workspace', 'google', 1, 13125, 12, 'half_yearly', '2026-06-19', '2026-12-19');
    raise exception 'A: the Suresh shape (half-yearly, 12 months, renewal 19 Dec 2026 on start 19 Jun 2026) was accepted';
  exception when sqlstate '22023' then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%18 Jun 2027%' or v_msg not like '%renewal date%' then
      raise exception 'A: refused, but the message does not say what to do: %', v_msg;
    end if;
  end;
end $$;

-- B. valid first-term rows pass (inclusive and anniversary). C. a renewed row passes.
insert into public.subscriptions
  (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle, start_date, renewal_date)
values
  ('25330000-0000-4000-8000-0000000000b1', '25330000-0000-4000-8000-000000000001', '25330000-0000-4000-8000-0000000000c1',
   'R2533 Customer', 'Workspace B1', 'google', 1, 13125, 12, 'half_yearly', '2026-06-19', '2027-06-18'),
  ('25330000-0000-4000-8000-0000000000b2', '25330000-0000-4000-8000-000000000001', '25330000-0000-4000-8000-0000000000c1',
   'R2533 Customer', 'Workspace B2', 'google', 1, 13125, 12, 'quarterly', '2026-06-19', '2027-06-19'),
  ('25330000-0000-4000-8000-0000000000b3', '25330000-0000-4000-8000-000000000001', '25330000-0000-4000-8000-0000000000c1',
   'R2533 Customer', 'Workspace B3', 'google', 1, 1000, 12, 'monthly', '2023-04-01', '2027-03-31'),
-- D. not split-billed: yearly with a short (co-termed) renewal; monthly on a 1-month term.
  ('25330000-0000-4000-8000-0000000000d1', '25330000-0000-4000-8000-000000000001', '25330000-0000-4000-8000-0000000000c1',
   'R2533 Customer', 'Workspace D1', 'google', 1, 1000, 12, 'yearly', '2026-09-30', '2026-12-31'),
  ('25330000-0000-4000-8000-0000000000d2', '25330000-0000-4000-8000-000000000001', '25330000-0000-4000-8000-0000000000c1',
   'R2533 Customer', 'Workspace D2', 'google', 1, 1000, 1, 'monthly', '2026-06-19', '2026-07-18');

-- E. editing a valid row into the Suresh shape is refused — by the date, and by the cycle.
do $$
begin
  begin
    update public.subscriptions set renewal_date = '2026-12-19' where id = '25330000-0000-4000-8000-0000000000b1';
    raise exception 'E1: renewal moved to 19 Dec 2026 on a 12-month half-yearly term was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    update public.subscriptions set billing_cycle = 'quarterly' where id = '25330000-0000-4000-8000-0000000000d1';
    raise exception 'E2: yearly row with renewal 31 Dec 2026 (start 30 Sep 2026) switched to quarterly was accepted';
  exception when sqlstate '22023' then null;
  end;
end $$;

-- G. a mid-term cancel writes the last day of service as renewal_date — allowed.
update public.subscriptions set status = 'cancelled', renewal_date = '2026-11-06'
 where id = '25330000-0000-4000-8000-0000000000b2';

-- F. a bad row made before the guard: other edits still work, and the repair goes through.
alter table public.subscriptions disable trigger trg_subscriptions_zzz_split_term_covers;
insert into public.subscriptions
  (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle, start_date, renewal_date)
values ('25330000-0000-4000-8000-0000000000f1', '25330000-0000-4000-8000-000000000001', '25330000-0000-4000-8000-0000000000c1',
        'R2533 Customer', 'Workspace F1', 'google', 1, 13125, 12, 'half_yearly', '2026-06-19', '2026-12-19');
alter table public.subscriptions enable trigger trg_subscriptions_zzz_split_term_covers;

update public.subscriptions set seats = 2 where id = '25330000-0000-4000-8000-0000000000f1';
update public.subscriptions set renewal_date = '2027-06-18' where id = '25330000-0000-4000-8000-0000000000f1';

do $$
begin
  if (select renewal_date from public.subscriptions where id = '25330000-0000-4000-8000-0000000000f1') <> '2027-06-18' then
    raise exception 'F: the repair to 18 Jun 2027 did not stick';
  end if;
  if (select count(*) from public.subscriptions where tenant_id = '25330000-0000-4000-8000-000000000001') <> 6 then
    raise exception 'B/C/D: expected 6 rows (b1 b2 b3 d1 d2 f1), got %',
      (select count(*) from public.subscriptions where tenant_id = '25330000-0000-4000-8000-000000000001');
  end if;
  raise notice 'PASS R-2533: Suresh shape refused on insert and edit; valid, renewed and non-split rows pass; old bad row still editable and repairable';
end $$;

rollback;
