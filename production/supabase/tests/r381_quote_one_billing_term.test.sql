-- R-381: one quote = one billing term (migration 20261007160000_quote_one_billing_term.sql).
-- Self-asserting; everything rolled back. Run on a LOCAL dev DB only.
--
-- Proves:
--   1. quote_line_terms_mixed: monthly + annual (or missing commitment) = mixed;
--      all-monthly / all-annual / empty / non-array = not mixed.
--   2. authenticated INSERT of a mixed quote is refused (check_violation).
--   3. authenticated INSERT of an all-monthly or all-annual quote passes.
--   4. authenticated UPDATE that introduces the mix is refused.
--   5. an existing mixed row (written by service role) stays editable by authenticated.
--   6. service_role INSERT of a mixed quote passes (cart checkout).
-- The trigger reads auth.role() from request.jwt.claims; the test runs as the DB owner
-- (RLS bypassed) and only switches the claimed role, so it tests the trigger, not RLS.
begin;

do $$
begin
  if not public.quote_line_terms_mixed('[{"commitment":"monthly"},{"commitment":"annual_yearly"}]') then
    raise exception 'FAIL 1a: monthly + annual should be mixed'; end if;
  if not public.quote_line_terms_mixed('[{"commitment":"monthly"},{"name":"x"}]') then
    raise exception 'FAIL 1b: monthly + missing commitment should be mixed'; end if;
  if public.quote_line_terms_mixed('[{"commitment":"monthly"},{"commitment":"monthly"}]') then
    raise exception 'FAIL 1c: all monthly is not mixed'; end if;
  if public.quote_line_terms_mixed('[{"commitment":"annual_monthly"},{}]') then
    raise exception 'FAIL 1d: all annual is not mixed'; end if;
  if public.quote_line_terms_mixed('[]') or public.quote_line_terms_mixed(null) or public.quote_line_terms_mixed('{}') then
    raise exception 'FAIL 1e: empty / null / object is not mixed'; end if;
  raise notice 'PASS 1: quote_line_terms_mixed';
end $$;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('eeeeeeee-0000-0000-0000-000000000381','R381 TEST','r381@example.in','06','R381');

-- 6. service role may write a mixed quote (cart checkout)
insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values ('Q-R381-SVC','eeeeeeee-0000-0000-0000-000000000381','Svc Co',1180,1000,18,'draft','none',
          '[{"name":"Hosting","qty":1,"rate":500,"commitment":"monthly"},{"name":"Domain","qty":1,"rate":500,"commitment":"annual_yearly"}]'::jsonb);

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);

do $$
declare v_refused boolean;
begin
  -- 2. mixed insert refused
  v_refused := false;
  begin
    insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
      values ('Q-R381-MIX','eeeeeeee-0000-0000-0000-000000000381','Mix Co',1180,1000,18,'draft','none',
              '[{"name":"Flex","qty":1,"rate":500,"commitment":"monthly"},{"name":"Annual","qty":1,"rate":500}]'::jsonb);
  exception when check_violation then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 2: authenticated mixed insert was accepted'; end if;
  raise notice 'PASS 2: authenticated mixed insert refused';

  -- 3. single-term inserts pass
  insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
    values ('Q-R381-MON','eeeeeeee-0000-0000-0000-000000000381','Mon Co',1180,1000,18,'draft','none',
            '[{"name":"Flex","qty":1,"rate":500,"commitment":"monthly"},{"name":"Flex 2","qty":1,"rate":500,"commitment":"monthly"}]'::jsonb);
  insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
    values ('Q-R381-ANN','eeeeeeee-0000-0000-0000-000000000381','Ann Co',1180,1000,18,'draft','none',
            '[{"name":"Annual","qty":1,"rate":500,"commitment":"annual_yearly"},{"name":"Annual 2","qty":1,"rate":500}]'::jsonb);
  raise notice 'PASS 3: all-monthly and all-annual inserts accepted';

  -- 4. update that introduces the mix refused
  v_refused := false;
  begin
    update public.quotes
       set line_items = line_items || '[{"name":"Flex","qty":1,"rate":50,"commitment":"monthly"}]'::jsonb
     where id = 'Q-R381-ANN';
  exception when check_violation then v_refused := true;
  end;
  if not v_refused then raise exception 'FAIL 4: update introducing the mix was accepted'; end if;
  raise notice 'PASS 4: update introducing the mix refused';

  -- 5. an existing mixed row stays editable
  update public.quotes
     set line_items = jsonb_set(line_items, '{0,qty}', '2'::jsonb)
   where id = 'Q-R381-SVC';
  if (select (line_items->0->>'qty')::int from public.quotes where id = 'Q-R381-SVC') <> 2 then
    raise exception 'FAIL 5: old mixed row edit did not apply'; end if;
  raise notice 'PASS 5: existing mixed row still editable';
end $$;

rollback;
