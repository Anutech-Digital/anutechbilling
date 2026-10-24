-- deploy-peek: (exists(select 1 from pg_indexes where schemaname = 'public' and tablename = 'tenant_domains' and indexname = 'tenant_domains_domain_unique' and indexdef like '%WHERE (verified_at IS NOT NULL)%') and exists(select 1 from pg_indexes where schemaname = 'public' and tablename = 'tenant_domains' and indexname = 'tenant_domains_tenant_domain_unique'))
-- deploy-key: r858domainunique
-- 20261023173000_r858_tenant_domains_verified_unique.sql
--
-- R-858 (found by the R-720 worker, 11 Oct; still open in the 19 Oct audit): an UNVERIFIED
-- domain claim could block the real company.
--
-- ══ THE HOLE ═════════════════════════════════════════════════════════════════════
--   baseline.sql: CREATE UNIQUE INDEX tenant_domains_domain_unique ON tenant_domains (lower(domain))
--   — over EVERY row, verified or not. After R-720 any owner may add an unverified claim, so
--   whoever types victimcorp.com first holds it; the real Victimcorp's signup claim then fails
--   with 23505 (signup swallows it silently) and an operator could only verify the squatter's row.
--   An unverified row routes nobody (resolveDomainOwner needs verified_at), so the only thing the
--   squatter gained was to block the owner — exactly what the index was supposed to prevent.
--
-- ══ THE RULE NOW ═════════════════════════════════════════════════════════════════
--   tenant_domains_domain_unique         lower(domain) WHERE verified_at IS NOT NULL
--                                        → any number of unverified claims per domain; only ONE
--                                          company can ever be verified for it. Verifying a second
--                                          row (operator / service_role) fails with 23505.
--   tenant_domains_tenant_domain_unique  (tenant_id, lower(domain)) — one claim per company per
--                                        domain, so signup's "already claimed → 23505, skip" still
--                                        holds for the same company.
--
-- ══ EXISTING DATA ════════════════════════════════════════════════════════════════
--   The old index was stricter than both new ones, so a database that has it can hold no
--   duplicates. If one exists anyway (index dropped by hand, half-applied script) this migration
--   STOPS and names the domains — it never picks a winner by itself; an operator decides which
--   row is the real owner.
--
-- Re-runnable: drop index if exists / create unique index if not exists. Catalog-only peek.
-- App side (same commit): /api/auth/onboarding/join-request now prefers the verified row and
-- no longer breaks when several unverified claims exist.
-- Test: supabase/tests/r858_tenant_domains_verified_unique.test.sql (rolled back).

begin;

do $$
declare
  v_dupes text;
begin
  select string_agg(format('%s (%s verified rows)', d, n), ', ')
    into v_dupes
    from (select lower(domain) as d, count(*) as n
            from public.tenant_domains
           where verified_at is not null
           group by lower(domain)
          having count(*) > 1) x;
  if v_dupes is not null then
    raise exception 'R-858: these domains are verified for more than one company: %. Decide which company really owns each one, clear verified_at on the others, then run this migration again.', v_dupes;
  end if;

  select string_agg(format('%s / %s (%s rows)', t, d, n), ', ')
    into v_dupes
    from (select tenant_id::text as t, lower(domain) as d, count(*) as n
            from public.tenant_domains
           group by tenant_id, lower(domain)
          having count(*) > 1) x;
  if v_dupes is not null then
    raise exception 'R-858: these companies claim the same domain more than once (tenant / domain): %. Delete the extra rows, then run this migration again.', v_dupes;
  end if;
end $$;

-- Build the per-company index first, then swap the domain index — no moment without a rule.
create unique index if not exists tenant_domains_tenant_domain_unique
  on public.tenant_domains (tenant_id, lower(domain));

drop index if exists public.tenant_domains_domain_unique;
create unique index tenant_domains_domain_unique
  on public.tenant_domains (lower(domain))
  where verified_at is not null;

commit;
