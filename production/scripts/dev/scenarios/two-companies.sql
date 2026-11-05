-- R-2476 scenario "two-companies" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- One login in two companies (R-2471 memberships): a second local company "SCN Second Company Pvt Ltd" and an
-- ACTIVE membership in it, as Manager, for E2E Test Co's first owner — the login "Local test login → Owner"
-- uses. That login then sees the company switcher in the top bar: E2E Test Co (Owner, ticked) and
-- SCN Second Company Pvt Ltd (Manager). The second company has no customers, quotes or invoices, so after a
-- switch every list is empty — nothing of E2E Test Co may show.
-- --reset / --clear first move that login back to E2E Test Co if it was left switched into the second
-- company (_common.sql scn_extra_clear), then remove the company (its membership goes with it).

insert into public.tenants (id, name, email, state, workspace_kind)
values ('c2476000-0000-4000-8000-000000000001', 'SCN Second Company Pvt Ltd', 'scn-second-company@example.test',
        'Delhi', 'business');

insert into public.tenant_memberships (user_id, tenant_id, role, is_active)
select u.id, 'c2476000-0000-4000-8000-000000000001', 'manager', true
  from public.users u
 where u.tenant_id = :'tenant' and u.role = 'owner' and u.is_active
 order by u.created_at
 limit 1;
