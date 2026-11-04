-- R-2458 scenario "connected-companies" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- G-NETWORK (R-2433 / R-2445 / R-2434 / R-2449 / R-2450): a SECOND local company, "SCN Network Partner
-- Pvt Ltd" (Delhi), connected to E2E Test Co:
--   · both GSTINs registered (gstin_verified_at) AND ownership proved (platform_admin, by "R-2458 scenario");
--   · an ACCEPTED connection: the partner shares invoices + partner metrics, E2E Test Co shares invoices + payments;
--   · two of the partner's invoices waiting in E2E Test Co's Purchases → Purchase Inbox → From network (Pending):
--     SNP/26-27/0101 ₹11,800 (accept it) and SNP/26-27/0102 ₹5,900 (reject it with a reason).
-- There is no login for the second company yet (Local test login lands in E2E Test Co) — see the card list.

insert into public.tenants (id, name, email, gstin, state, workspace_kind, gstin_verified_at,
                            gstin_owner_verified_at, gstin_owner_verified_gstin, gstin_owner_verified_how, gstin_owner_verified_by)
values ('c2458000-0000-4000-8000-000000000081', 'SCN Network Partner Pvt Ltd', 'scn-network-partner@example.test',
        '07AAECS2458K1Z4', 'Delhi', 'business', now() - interval '10 days',
        now() - interval '9 days', '07AAECS2458K1Z4', 'platform_admin', 'R-2458 scenario');

-- E2E Test Co: its GSTIN registered + proved. Only when not proved yet (a real R-2445 proof is kept); the stamp
-- says it was this scenario, and --clear takes back only that stamp.
update public.tenants
   set gstin_verified_at = coalesce(gstin_verified_at, now() - interval '10 days'),
       gstin_owner_verified_at = now() - interval '9 days',
       gstin_owner_verified_gstin = upper(btrim(gstin)),
       gstin_owner_verified_how = 'platform_admin',
       gstin_owner_verified_by = 'R-2458 scenario'
 where id = :'tenant' and nullif(btrim(coalesce(gstin, '')), '') is not null and gstin_owner_verified_at is null;

insert into public.tenant_connections (id, a_tenant_id, b_tenant_id, a_gstin, b_gstin, status, a_scopes, b_scopes,
                                       related_party, origin, requested_at, responded_at)
select 'c2458000-0000-4000-8000-000000000082', 'c2458000-0000-4000-8000-000000000081', t.id,
       '07AAECS2458K1Z4', upper(btrim(t.gstin)), 'accepted', array['invoices', 'partner_metrics'], array['invoices', 'payments'],
       false, 'request', now() - interval '3 days', now() - interval '2 days'
  from public.tenants t where t.id = :'tenant';

insert into public.network_documents (id, kind, seller_tenant_id, buyer_tenant_id, connection_id, seller_invoice_id,
                                      seller_gstin, buyer_gstin, seller_name, doc_number, doc_date, fy, document_type,
                                      taxable_value, cgst, sgst, igst, total, currency, payload, status)
select v.id, 'invoice', 'c2458000-0000-4000-8000-000000000081', t.id, 'c2458000-0000-4000-8000-000000000082', v.inv,
       '07AAECS2458K1Z4', upper(btrim(t.gstin)), 'SCN Network Partner Pvt Ltd', v.num, current_date - v.age,
       public.network_fy(current_date - v.age), 'tax_invoice', v.taxable, 0, 0, v.igst, v.taxable + v.igst, 'INR',
       jsonb_build_object('due_date', current_date - v.age + 15, 'lines', jsonb_build_array(jsonb_build_object(
         'description', v.what, 'hsn', '998315', 'quantity', 1, 'rate', v.taxable, 'amount', v.taxable))),
       'pending'
  from (values
    ('c2458000-0000-4000-8000-000000000083'::uuid, 'INV-SCN-NP-0101', 'SNP/26-27/0101', 5, 10000, 1800, 'SCN Cloud backup — 10 users (annual)'),
    ('c2458000-0000-4000-8000-000000000084'::uuid, 'INV-SCN-NP-0102', 'SNP/26-27/0102', 3,  5000,  900, 'SCN Email security add-on')
  ) as v(id, inv, num, age, taxable, igst, what)
  cross join public.tenants t where t.id = :'tenant';
