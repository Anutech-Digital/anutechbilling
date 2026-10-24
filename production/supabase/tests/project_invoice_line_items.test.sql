-- Regression test: a project-milestone tax invoice carries its particulars (R-010).
-- Migration 20260930178000. Rolled back — safe on production.
--
--   PRESENT   one line item, named "<project> — <milestone>"
--   EXACT     qty × rate = the invoice's own taxable_value
--   SAC       from project_sales.sac_code, not a literal — a project on another code
--             puts THAT code on its invoice
--   BACKFILL  an invoice raised before this migration gets its line, and its amount
--             is not touched
--   FROZEN    a line already written cannot be replaced
--
-- The EXACT case is the one worth the file. CGST Rule 46 is satisfied by any plausible
-- description, so a test that only checked "is there a line?" would stay green over a
-- line that says ₹5,90,000 on a ₹5,00,000 taxable value — a tax invoice contradicting
-- itself in print, which is worse than the blank it replaced.
--
-- Fixture owns its data (L11). service_role throughout: this asserts what the function
-- WRITES, and its tenant guard is covered by definer_rpc_hardening.test.sql.

begin;

-- R-1643 / R-1803: issuing a Tax Invoice (also instalment + project invoices) needs the company's own GSTIN + address (supplier_invoice_problem).
-- Every company this test creates gets both unless the test sets them itself (an unregistered
-- one gets only the address). Rolled back with the test.
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

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code)
  values ('01000000-0000-4000-8000-000000000001', 'R010 TEST', 'r010@example.in', '07', 'R10T');

insert into public.customers (id, tenant_id, name, state_code, country)
  values ('01000000-0000-4000-8000-0000000000c1', '01000000-0000-4000-8000-000000000001',
          'Cust R010', '07', 'India');

-- ₹5,00,000 taxable + 18% = ₹5,90,000, billed in two milestones. The numbers from the
-- bug report, so the assertions below are the figures Pardeep actually saw.
insert into public.project_sales
  (id, tenant_id, customer_id, customer_name, title, description,
   gst_rate, inter_state, taxable_amount, gst_amount, total_amount)
values
  ('01000000-0000-4000-8000-0000000000a1', '01000000-0000-4000-8000-000000000001',
   '01000000-0000-4000-8000-0000000000c1', 'Cust R010', 'Complete Billing System',
   'Design, build and hand over the billing module.',
   18, false, 500000, 90000, 590000);

/* A second project on a DIFFERENT SAC. Without it the test would pass just as well
   against a hardcoded 998314, which is the mistake this line exists to catch — the
   column already exists and defaults to that value, so a literal looks identical until
   somebody sells something else. */
insert into public.project_sales
  (id, tenant_id, customer_id, customer_name, title, sac_code,
   gst_rate, inter_state, taxable_amount, gst_amount, total_amount)
values
  ('01000000-0000-4000-8000-0000000000a2', '01000000-0000-4000-8000-000000000001',
   '01000000-0000-4000-8000-0000000000c1', 'Cust R010', 'Server migration', '998315',
   18, false, 100000, 18000, 118000);

insert into public.project_milestones (id, tenant_id, project_id, seq, label, total_amount)
values
  ('01000000-0000-4000-8000-0000000000b1', '01000000-0000-4000-8000-000000000001',
   '01000000-0000-4000-8000-0000000000a1', 2, 'Doosri kist (advance)', 590000),
  ('01000000-0000-4000-8000-0000000000b2', '01000000-0000-4000-8000-000000000001',
   '01000000-0000-4000-8000-0000000000a2', 1, 'Full amount', 118000),
  -- Raised the OLD way below, to stand in for an invoice issued before this migration.
  ('01000000-0000-4000-8000-0000000000b3', '01000000-0000-4000-8000-000000000001',
   '01000000-0000-4000-8000-0000000000a1', 3, 'Teesri kist', 118000);

do $$
declare
  v_inv   text;
  v_inv2  text;
  v_line  jsonb;
  v_n     int;
  v_tax   int;
  v_amt   int;
  v_err   boolean;
begin
  -- ── A milestone invoice now carries its particulars ──────────────────────
  v_inv := public.raise_project_milestone_invoice('01000000-0000-4000-8000-0000000000b1');

  select jsonb_array_length(line_items), taxable_value, amount
    into v_n, v_tax, v_amt
    from public.invoices where id = v_inv;
  if coalesce(v_n, 0) <> 1 then
    raise exception 'FAIL 1: invoice % has % line item(s) — the PDF still prints "No line items"', v_inv, coalesce(v_n, -1);
  end if;

  select line_items->0 into v_line from public.invoices where id = v_inv;

  if v_line->>'name' <> 'Complete Billing System — Doosri kist (advance)' then
    raise exception 'FAIL 2: line reads %, not the project and the milestone', v_line->>'name';
  end if;

  /* Rule 46(g) is about the DESCRIPTION of the service. The operator already typed one
     on the project; dropping it on the floor and printing only a label would meet the
     letter of the card and not the point of the rule. */
  if coalesce(v_line->>'description', '') <> 'Design, build and hand over the billing module.' then
    raise exception 'FAIL 3: the project description did not reach the invoice line (got %)', coalesce(v_line->>'description', '<null>');
  end if;

  -- ── The line must agree with the invoice's own frozen tax split ──────────
  if (v_line->>'qty')::int * (v_line->>'rate')::int <> v_tax then
    raise exception 'FAIL 4: qty x rate = % but taxable_value = % — the document contradicts itself',
      (v_line->>'qty')::int * (v_line->>'rate')::int, v_tax;
  end if;
  if (v_line->>'rate')::int = v_amt then
    /* The R-066 shape, in the other direction: putting the GST-INCLUSIVE gross on the
       line would make the invoice add up to 118% of itself. */
    raise exception 'FAIL 4: the line carries the gross (%), not the taxable value', v_amt;
  end if;
  if v_line->>'hsn' <> '998314' then
    raise exception 'FAIL 5: SAC on the line is %, expected the project''s 998314', coalesce(v_line->>'hsn', '<null>');
  end if;

  -- ── A project on a different SAC carries ITS code ────────────────────────
  v_inv2 := public.raise_project_milestone_invoice('01000000-0000-4000-8000-0000000000b2');
  select line_items->0 into v_line from public.invoices where id = v_inv2;
  if v_line->>'hsn' <> '998315' then
    raise exception 'FAIL 6: SAC is % — the code is hardcoded, not read from the project', coalesce(v_line->>'hsn', '<null>');
  end if;
  if (v_line->>'rate')::int <> 100000 then
    raise exception 'FAIL 6: taxable backed out of ₹1,18,000 came to %, expected 100000', (v_line->>'rate')::int;
  end if;

  -- ── Backfill: an invoice raised before this migration ────────────────────
  /* Written the old way on purpose — line_items left NULL — because the backfill is the
     half that decides whether the invoices this business has ALREADY issued get fixed,
     and it is the half a unit test cannot see. */
  insert into public.invoices
    (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date,
     adjusted_advances, net_payable, taxable_value, tax_amount, tax_rate, inter_state)
  values
    ('INV-R10T-27-9001', '01000000-0000-4000-8000-000000000001',
     '01000000-0000-4000-8000-0000000000c1', 'Cust R010', 118000, 'pending',
     current_date, current_date, '[]'::jsonb, 118000, 100000, 18000, 18, false);
  update public.project_milestones set invoice_id = 'INV-R10T-27-9001'
   where id = '01000000-0000-4000-8000-0000000000b3';

  update public.invoices i
     set line_items = jsonb_build_array(jsonb_build_object(
           'id',          'milestone-' || m.seq::text,
           'name',        coalesce(nullif(btrim(p.title), ''), 'Project services')
                          || ' — '
                          || coalesce(nullif(btrim(m.label), ''), 'Milestone ' || m.seq::text),
           'description', nullif(btrim(coalesce(p.description, '')), ''),
           'qty',         1,
           'rate',        coalesce(i.taxable_value,
                                   round(i.amount * 100.0 / (100 + coalesce(i.tax_rate, 18)))),
           'cost',        0,
           'hsn',         p.sac_code
         ))
    from public.project_milestones m
    join public.project_sales p on p.id = m.project_id
   where m.invoice_id = i.id
     and i.line_items is null;

  select line_items->0, amount into v_line, v_amt
    from public.invoices where id = 'INV-R10T-27-9001';
  if v_line is null then
    raise exception 'FAIL 7: an invoice issued before this migration kept printing nothing';
  end if;
  if v_line->>'name' <> 'Complete Billing System — Teesri kist' then
    raise exception 'FAIL 7: backfilled line reads %', v_line->>'name';
  end if;
  if (v_line->>'rate')::int <> 100000 then
    raise exception 'FAIL 7: backfill read the rate as %, not the invoice''s frozen 100000', (v_line->>'rate')::int;
  end if;
  if v_amt <> 118000 then
    raise exception 'FAIL 8: the backfill moved the invoice amount to %', v_amt;
  end if;

  -- ── And it cannot be run over a line that already exists ─────────────────
  /* The freeze trigger''s ONCE-SET tier: null may be filled, a value may not be replaced.
     This is what makes the backfill safe to re-run and unsafe to abuse. */
  v_err := false;
  begin
    update public.invoices set line_items = '[]'::jsonb where id = 'INV-R10T-27-9001';
  exception when others then v_err := true; end;
  if not v_err then
    raise exception 'FAIL 9: an issued invoice''s line items were replaced — the freeze does not hold';
  end if;

  raise notice 'PASS: project invoices carry description + SAC (% and %), and old ones backfill', v_inv, v_inv2;
end $$;

rollback;
