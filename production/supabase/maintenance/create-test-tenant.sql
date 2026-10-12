-- ═══════════════════════════════════════════════════════════════════════════
--  CREATE THE TESTING SANDBOX TENANT
--  Written 21 Aug 2026, on Pardeep's decision: testers must not write into the
--  tenant holding the real books.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  ─── WHY A SEPARATE TENANT AND NOT "JUST BE CAREFUL" ──────────────────────
--  Measured 21 Aug 2026, the live tenant holds 14 customers, 25 quotes, 21
--  invoices, 23 payments and 28 subscriptions. Those are PER-TENANT counts; the
--  DB-wide totals are higher (15/27/22/24/30) because the historical Demo
--  Co tenant holds the difference. Mixing the two is how a per-tenant
--  assertion ends up written against a global number — which is exactly what
--  happened on the first run of this file, and why the guards below caught it.
--  This project is on the Supabase
--  free plan: no PITR, no automatic backups (docs/BACKUP.md). A tester's junk
--  rows would mix into those, every dashboard total would count them, and
--  separating them afterwards means reading a tester's mind. RLS is already
--  tenant-scoped on every table, so a second tenant is a real wall, not a
--  convention.
--
--  ─── THE NAME IS DELIBERATELY UGLY ────────────────────────────────────────
--  Tenant names in this product are derived from an email domain, so a wrong
--  tenant reads exactly like the right one -- that is how a private "Demo
--  Co" tenant held two days of real work and a ₹21,240 payment before
--  anyone noticed (CLAUDE.md §4a). This one is named so that nobody can mistake
--  it for a company, and it sorts to the bottom of any list.
--
--  ─── WHAT IS SEEDED, AND WHAT IS NOT ──────────────────────────────────────
--  Seeded: the item catalogue, copied from the live tenant (25 rows, new ids).
--  Typing a price list is tedious and proves nothing.
--
--  NOT seeded: customers, leads, quotes, invoices, payments. Those are the
--  money spine -- lead → quote → pay → invoice → renewal -- and creating them
--  IS the test. Handing a tester finished rows would skip the thing being
--  tested and hide every bug in the creating.
--
--  ─── HOW A TESTER GETS IN ─────────────────────────────────────────────────
--  Not by a password anyone shares. `team_invites` pins an exact email address
--  to a tenant, and the OAuth callback's first branch joins an invited address
--  to THAT tenant -- so a Google sign-in lands in this sandbox and cannot land
--  in the live tenant. Run add-test-tenant-invite.sql with the tester's address.
--
--  Safe to re-run: every statement is idempotent.
begin;

insert into public.tenants (id, name, email, state, state_code, doc_code, address, phone)
values (
  '7e57e57e-0000-4000-8000-000000000001',
  'ZZ TESTING SANDBOX — not a real company',
  'testing@anutech.in',
  'Delhi', '07',
  'TEST',                       -- document series stays separate from ADPL
  'Sandbox — testing only, New Delhi 110001',
  '+91 00000 00000'
)
on conflict (id) do nothing;

-- Item catalogue, copied from the live tenant so prices and HSN codes are real.
-- items.id is the primary key on its own (not composite with tenant_id), so the
-- copies need their own ids -- hence the TST- prefix.
-- margin_pct is a GENERATED column -- computed from msrp/wholesale, cannot be inserted.
insert into public.items (id, tenant_id, name, vendor, hsn, msrp, wholesale, is_active, kind, item_type)
select
  'TST-' || i.id,
  '7e57e57e-0000-4000-8000-000000000001',
  i.name, i.vendor, i.hsn, i.msrp, i.wholesale, i.is_active, i.kind, i.item_type
from public.items i
where i.tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
on conflict (id) do nothing;

do $$
declare
  v_tenant uuid := '7e57e57e-0000-4000-8000-000000000001';
  v_live   uuid := 'fbb976f1-9090-4f10-9726-0901bd144e42';
  n integer;
  m integer;
begin
  select count(*) into n from public.tenants where id = v_tenant;
  if n <> 1 then raise exception 'FAIL: sandbox tenant not created'; end if;

  select count(*) into n from public.items where tenant_id = v_tenant;
  select count(*) into m from public.items where tenant_id = v_live;
  if n <> m then
    raise exception 'FAIL: sandbox has % items, live tenant has % -- catalogue copy incomplete', n, m;
  end if;

  -- The wall, asserted rather than assumed: nothing of the real business may have
  -- been dragged across by the copy.
  select count(*) into n from public.customers where tenant_id = v_tenant;
  if n <> 0 then raise exception 'FAIL: % customer(s) leaked into the sandbox', n; end if;
  select count(*) into n from public.quotes where tenant_id = v_tenant;
  if n <> 0 then raise exception 'FAIL: % quote(s) leaked into the sandbox', n; end if;
  select count(*) into n from public.invoices where tenant_id = v_tenant;
  if n <> 0 then raise exception 'FAIL: % invoice(s) leaked into the sandbox', n; end if;
  select count(*) into n from public.payments where tenant_id = v_tenant;
  if n <> 0 then raise exception 'FAIL: % payment(s) leaked into the sandbox', n; end if;

  -- And the live tenant must be exactly as it was.
  select count(*) into n from public.items where tenant_id = v_live;
  if n <> 25 then raise exception 'FAIL: live tenant now has % items, expected 25', n; end if;
  select count(*) into n from public.invoices where tenant_id = v_live;
  if n <> 21 then raise exception 'FAIL: live tenant now has % invoices, expected 21', n; end if;
  select count(*) into n from public.payments where tenant_id = v_live;
  if n <> 23 then raise exception 'FAIL: live tenant now has % payments, expected 23', n; end if;
end $$;

select 'SANDBOX-READY' as create_test_tenant;

commit;
