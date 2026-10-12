-- Record the place of supply for nine customers who never had one.
--
-- WHY THIS IS A RECORD-KEEPING FIX AND NOT A TAX CORRECTION
--   lib/gst/mismatch.ts flagged nine customers with no state and no usable GSTIN whose
--   invoices had all gone out as intra-state (CGST + SGST). That head was never
--   DETERMINED — isInterStateSupply returns false for an unknown buyer, and false means
--   intra-state, so "we do not know" produced a confident Delhi invoice.
--
--   Pardeep confirmed on 22 Aug 2026 that all nine are in fact Delhi customers. So the
--   invoices already issued are CORRECT and no credit note is needed. What was missing was
--   the evidence, not the answer.
--
--   That distinction is the whole reason to ask before writing: had even one been outside
--   Delhi, this script would have been the wrong action and the right one would have been
--   a credit note under CGST s.34.
--
-- WHY BY ID AND NOT BY NAME
--   This book contains "AB corprotion", "abc corporaton" and "Demo Co", and one
--   of those — AB corprotion — is NOT in this list: it has a state already (32) and a
--   broken GSTIN, which is a different problem needing a different answer. Matching on
--   names that differ by two characters is how the wrong customer gets a tax attribute.
--
-- WHAT IT TOUCHES: customers.state_code and customers.state, on nine ids, and nothing
-- else. No invoice, no tax amount, no GSTIN.
--
-- GUARDED so a re-run or a since-corrected row is a no-op rather than an overwrite: the
-- WHERE clause requires the state to still be empty. If somebody has filled one in
-- meanwhile — with a different state — this leaves it alone, which is correct, because
-- their information is newer than mine.

update public.customers
   set state_code = '07',
       state      = 'Delhi'          -- spelled to match the tenant row and the one existing 07 customer
 where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
   and (state_code is null or trim(state_code) = '')
   and id in (
     'c1aa8318-d57f-4633-b0fa-976b221f1966',   -- abc corporaton        1 invoice
     'fcc098c1-cca6-40ca-a794-3acf39200dc4',   -- Demo Co    2 invoices
     '2084e1af-36ce-4669-b9cf-b43ac5484563',   -- Jijo corprotion       3 invoices
     '00d38be0-05f0-468d-81f9-b44f12c2b246',   -- Joel                  1 invoice
     'a688a035-2d5f-439c-af35-72e75133b94f',   -- KAILASH CORPROTION    2 invoices
     'cb6baa70-21d9-418c-8bda-6da85a1240f8',   -- Pankaj                1 invoice
     'be5fe9be-79e2-4d5e-8f87-ae111617214f',   -- Pardeep Sharma        1 invoice
     '1af26d89-e676-4657-a03b-4b93bfa9cdee',   -- POP TECH              1 invoice
     'ff3d45d0-04c7-408d-83e6-d12a3a04a1dc'    -- ROHINI TECH           1 invoice
   )
returning id, name, state_code, state;
