-- Regression test: an invoice is not issued with an unknown place of supply, and a credit
-- note is refused past its CGST Section 34(2) deadline. Migration 20260930174000 (R-041).
-- Rolled back — safe on production.
--
-- Both halves, because a guard is only half-tested by what it blocks:
--
--   BLOCKED  a domestic customer with no state_code — the tax head cannot be decided
--   BLOCKED  a seller with no state_code — same question, other side
--   BLOCKED  a credit note raised after 30 November of the following financial year
--   ALLOWED  an EXPORT customer with no Indian state (zero-rated; nothing to split)
--   ALLOWED  the ordinary intra-state and inter-state cases, with the right head
--   ALLOWED  a credit note inside the deadline
--
-- The ALLOWED half is what stops the guard being deleted: refusing an export, or refusing
-- every credit note, would block work people do every day (L28, L103).
--
-- Fixture owns its data (L11): its own tenants, customers, quotes. Literal ids.

begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address (supplier_invoice_problem).
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

-- Seller in Delhi (07).
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('b0510000-0000-4000-8000-000000000001', 'POS TEST', 'pos@example.in', '07', 'POST');
-- …and a seller with no state at all, for the other-side case.
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('b0510000-0000-4000-8000-000000000002', 'POS NOSTATE', 'pos2@example.in', null, 'POSX');

insert into public.customers (id, tenant_id, name, state_code, country) values
  -- no state, domestic → must be refused
  ('b0510000-0000-4000-8000-0000000000c1', 'b0510000-0000-4000-8000-000000000001', 'No State Ltd',  null, 'India'),
  -- same state → CGST+SGST
  ('b0510000-0000-4000-8000-0000000000c2', 'b0510000-0000-4000-8000-000000000001', 'Delhi Ltd',     '07', 'India'),
  -- other state → IGST
  ('b0510000-0000-4000-8000-0000000000c3', 'b0510000-0000-4000-8000-000000000001', 'Mumbai Ltd',    '27', 'India'),
  -- outside India, no Indian state → allowed, zero-rated
  ('b0510000-0000-4000-8000-0000000000c4', 'b0510000-0000-4000-8000-000000000001', 'Acme Inc',      null, 'United States'),
  -- for the seller-has-no-state case
  ('b0510000-0000-4000-8000-0000000000c5', 'b0510000-0000-4000-8000-000000000002', 'Any Ltd',       '07', 'India');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                           status, payment_status, line_items) values
  ('Q-POS-NOSTATE', 'b0510000-0000-4000-8000-000000000001', 'b0510000-0000-4000-8000-0000000000c1', 'No State Ltd', 118000, 100000, 18, 'accepted', 'received', '[]'::jsonb),
  ('Q-POS-INTRA',   'b0510000-0000-4000-8000-000000000001', 'b0510000-0000-4000-8000-0000000000c2', 'Delhi Ltd',    118000, 100000, 18, 'accepted', 'received', '[]'::jsonb),
  ('Q-POS-INTER',   'b0510000-0000-4000-8000-000000000001', 'b0510000-0000-4000-8000-0000000000c3', 'Mumbai Ltd',   118000, 100000, 18, 'accepted', 'received', '[]'::jsonb),
  -- An export quote carries tax_rate 0, exactly as lib/gst/place-of-supply sets it.
  ('Q-POS-EXPORT',  'b0510000-0000-4000-8000-000000000001', 'b0510000-0000-4000-8000-0000000000c4', 'Acme Inc',     100000, 100000,  0, 'accepted', 'received', '[]'::jsonb),
  ('Q-POS-NOSELL',  'b0510000-0000-4000-8000-000000000002', 'b0510000-0000-4000-8000-0000000000c5', 'Any Ltd',      118000, 100000, 18, 'accepted', 'received', '[]'::jsonb);

do $$
declare
  v_err boolean; v_msg text; v_inv text; v_inter boolean; v_rate int; v_n int;
begin
  -- ── SETUP GUARD (L14): the fixtures must be reachable, or nothing below proves anything ──
  select count(*) into v_n from public.quotes where id like 'Q-POS-%';
  if v_n <> 5 then raise exception 'SETUP FAIL: % of 5 fixture quotes', v_n; end if;

  -- ── BLOCKED: domestic customer with no state ─────────────────────────────
  v_err := false;
  begin
    select invoice_id into v_inv from public.generate_invoice('Q-POS-NOSTATE');
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then
    raise exception 'FAIL 1: an invoice was issued for a customer with no state — the tax head was guessed';
  end if;
  /* §24 — the refusal must lead somewhere, and it must name the CUSTOMER so the operator
     knows which record to open. */
  if v_msg not like '%No State Ltd%' or v_msg not ilike '%Customers%' then
    raise exception 'FAIL 1: refusal did not name the customer and where to fix it: %', v_msg;
  end if;
  select count(*) into v_n from public.invoices where quote_id = 'Q-POS-NOSTATE';
  if v_n <> 0 then raise exception 'FAIL 1: an invoice row survived the raise'; end if;

  -- ── BLOCKED: the SELLER has no state ─────────────────────────────────────
  v_err := false;
  begin
    select invoice_id into v_inv from public.generate_invoice('Q-POS-NOSELL');
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then raise exception 'FAIL 2: issued with no state on the seller'; end if;
  if v_msg not ilike '%Settings%' then
    raise exception 'FAIL 2: refusal did not send the operator to Settings: %', v_msg;
  end if;

  -- ── ALLOWED: export, no Indian state, zero-rated ─────────────────────────
  /* The case the refusal must NOT catch. An overseas recipient has no Indian place of
     supply — that is correct, not missing — and blocking it would stop every export
     invoice, which is how a guard gets switched off (L103). */
  select invoice_id into v_inv from public.generate_invoice('Q-POS-EXPORT');
  select inter_state, tax_rate into v_inter, v_rate from public.invoices where id = v_inv;
  if v_inv is null then raise exception 'FAIL 3: an export invoice was refused'; end if;
  if v_rate <> 0 then raise exception 'FAIL 3: export invoice carried tax_rate %', v_rate; end if;

  -- ── ALLOWED: the two ordinary cases, with the RIGHT head ─────────────────
  select invoice_id into v_inv from public.generate_invoice('Q-POS-INTRA');
  select inter_state into v_inter from public.invoices where id = v_inv;
  if v_inter is not false then raise exception 'FAIL 4: same-state supply was marked inter-state'; end if;

  select invoice_id into v_inv from public.generate_invoice('Q-POS-INTER');
  select inter_state into v_inter from public.invoices where id = v_inv;
  if v_inter is not true then
    raise exception 'FAIL 5: a 07 -> 27 supply was billed as CGST+SGST — tax to the wrong government';
  end if;

  -- ── CREDIT NOTE: inside the deadline is allowed ──────────────────────────
  /* v_inv is the inter-state invoice, dated today, so it is well inside its window. */
  perform public.issue_credit_note(v_inv, 5000, 'other', 'test', null);
  select count(*) into v_n from public.credit_notes where invoice_id = v_inv;
  if v_n <> 1 then raise exception 'FAIL 6: a credit note inside the deadline was refused'; end if;

  -- ── CREDIT NOTE: past 30 November of the following FY is refused ─────────
  /* Back-date the invoice far enough that its Section 34(2) window has closed. paid_date
     and the particulars are untouched; invoice_date is frozen on an issued invoice, so the
     stated-reason hatch is used — which is also a small proof that the hatch still works. */
  perform set_config('app.invoice_amend_reason', 'R-041 test: age the invoice past its s34 window', true);
  update public.invoices set invoice_date = public.ist_today() - interval '4 years' where id = v_inv;
  perform set_config('app.invoice_amend_reason', '', true);

  v_err := false;
  begin
    perform public.issue_credit_note(v_inv, 1000, 'other', 'too late', null);
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then
    raise exception 'FAIL 7: a credit note was issued years after the supply — the GST on it cannot be reduced';
  end if;
  if v_msg not ilike '%34(2)%' and v_msg not ilike '%30 November%' then
    raise exception 'FAIL 7: refusal did not name the rule or the date: %', v_msg;
  end if;
  /* §24 again: a dead end here would leave the operator with no way to settle the money. */
  if v_msg not ilike '%refund%' then
    raise exception 'FAIL 7: refusal offered no alternative: %', v_msg;
  end if;

  raise notice 'PASS: unknown place of supply refused, export allowed, heads correct, s34 deadline enforced';
end $$;

rollback;
