-- Correct the one subscription storing an ANNUAL figure in its monthly MRR field
-- ============================================================================
-- 23 Aug 2026, on the operator's instruction ("mrr theek kar do") after being shown the
-- measurement and the caveat below.
--
-- THE ROW
--   c398e832-0b58-4d78-a5b7-a2fdd1871fc9 — "Xyz cloud solutions"
--   10 seats · Google Workspace Business Starter · term_months = 1 · renewal 27 Aug
--   auto_renew = true
--   mrr = 32,400  →  ₹3,240 per seat per month, against a ₹270 catalogue price
--
-- It is the ONLY row in the database like this: a sweep of every subscription joined to
-- its catalogue item found exactly one above 2x the catalogue rate, and its ratio is
-- 12.00 — an annual figure in a monthly field, not a pricing decision.
--
-- WHY THIS MATTERED
-- create-renewal-quote.ts priced every renewal as `mrr * 12`, ignoring term_months. On
-- this row that came to ₹3,88,800 ex-GST — about 144x the correct ₹2,700 monthly charge —
-- four days out, on a subscription set to renew by itself. Commit 5dd1a73 makes the
-- pricing term-aware AND makes it refuse an annual-looking mrr rather than dividing by 12
-- to repair it, so the 144x quote can no longer be generated. This fixes the DATA so a
-- correct renewal quote can be.
--
-- ⚠️ WHAT THIS DOES NOT FIX, STATED PLAINLY
-- The error did not start here. The originating quote Q-TEST-2026-27-0009 carries
-- `commitment: "monthly"` with `rate: 3240` and `cost: 1320` per seat — 270x12 and 110x12,
-- both ANNUAL figures on a line calling itself monthly — and a payment of ₹38,232 was
-- recorded against it. `mrr` faithfully copied that quote's subtotal.
--
-- So after this runs, the subscription (₹2,700/month) will disagree with the quote and
-- payment that created it (₹32,400 for one month). That is accepted deliberately: the
-- future renewal becomes correct, the history stays wrong, and the history is SANDBOX
-- data (Q-TEST prefix, tenant Gammaco, domain "xyz.cloudsolutions"), so no real customer
-- was overcharged. Editing a paid quote to match would mean rewriting what was charged,
-- which is a different and much worse thing to do.
--
-- REVERSIBLE: the old value is in the notice below and in activity_log via the
-- subscriptions trigger.

begin;

do $$
declare
  v_id      uuid := 'c398e832-0b58-4d78-a5b7-a2fdd1871fc9';
  v_seats   int;
  v_mrr     int;
  v_term    int;
  v_catalog int;
  v_should  int;
begin
  select s.seats, s.mrr, s.term_months,
         (select i.msrp from public.items i
           where i.tenant_id = s.tenant_id and i.name = s.plan and i.msrp > 0 limit 1)
    into v_seats, v_mrr, v_term, v_catalog
    from public.subscriptions s where s.id = v_id;

  if not found then
    raise notice 'SKIP: subscription % not present', v_id;
    return;
  end if;

  if v_mrr is distinct from 32400 then
    raise exception 'REFUSING: expected mrr = 32400, found % — this row has changed since the script was written', v_mrr;
  end if;
  if v_catalog is null or v_catalog <= 0 then
    raise exception 'REFUSING: no catalogue price for this plan, so the correct mrr cannot be derived';
  end if;

  /* Derived from the catalogue, not typed in. A hardcoded 2700 would be a number nobody
     could check; this one recomputes if the seat count or the catalogue ever differs. */
  v_should := v_seats * v_catalog;

  /* Belt and braces: only proceed if the stored value really is ~12x the derived one.
     If it is anything else, this is not the defect described above. */
  if abs(v_mrr::numeric / v_should - 12) > 0.01 then
    raise exception 'REFUSING: stored mrr % is not 12x the derived % — not the annual-in-monthly defect', v_mrr, v_should;
  end if;

  update public.subscriptions set mrr = v_should where id = v_id;

  raise notice 'PASS: % mrr %  ->  %  (% seats x ₹% catalogue, term % month(s))',
    v_id, v_mrr, v_should, v_seats, v_catalog, v_term;
end $$;

select 'PASS' as fix_annual_mrr;

commit;
