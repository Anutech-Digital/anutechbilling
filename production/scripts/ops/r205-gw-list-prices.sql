-- R-205 (6 Oct 2026) — Google Workspace list prices in the `items` catalogue.
--
-- NOT APPLIED BY THE WORKER. Manager / Pardeep run it, staging first, then live (after 17:00
-- IST with his haan). Run as a role that bypasses RLS (Cloud SQL: --user=postgres).
--
-- Pardeep: Starter ₹3,240/yr = ₹270/seat/month, Standard ₹1,080, Plus ₹1,380 (whole rupees).
-- Rows created from the old seed (lib/queries/items.ts DEFAULT_CATALOG: 136 / 736) are
-- RAISED to the list price — msrp and prices.annual.msrp only. Wholesale (cost), the flexible
-- tier, slabs and any row already at or above list are left exactly as they are.
-- The app now floors these in code too (lib/catalog/workspace-floor.ts); this fixes the data.

BEGIN;

-- 1. Look first: which rows are below list?
SELECT tenant_id, id, name, msrp, prices->'annual'->>'msrp' AS annual_msrp
FROM items
WHERE vendor = 'google' AND kind = 'main'
  AND name ILIKE 'Google Workspace%'
  AND name NOT ILIKE '%enterprise%'
  AND (
       (name ILIKE '%starter%'  AND (msrp < 270  OR COALESCE((prices->'annual'->>'msrp')::numeric, 270)  < 270))
    OR (name ILIKE '%standard%' AND (msrp < 1080 OR COALESCE((prices->'annual'->>'msrp')::numeric, 1080) < 1080))
    OR (name ILIKE '%plus%'     AND (msrp < 1380 OR COALESCE((prices->'annual'->>'msrp')::numeric, 1380) < 1380))
  );

-- 2. Raise them.
WITH list(tier, price) AS (VALUES ('starter', 270), ('standard', 1080), ('plus', 1380)),
target AS (
  SELECT i.id, l.price
  FROM items i
  JOIN list l ON i.name ILIKE '%' || l.tier || '%'
  WHERE i.vendor = 'google' AND i.kind = 'main'
    AND i.name ILIKE 'Google Workspace%'
    AND i.name NOT ILIKE '%enterprise%'
    AND (i.msrp < l.price OR COALESCE((i.prices->'annual'->>'msrp')::numeric, l.price) < l.price)
)
UPDATE items i
SET msrp   = GREATEST(i.msrp, t.price),
    prices = CASE
               WHEN i.prices ? 'annual'
                 THEN jsonb_set(i.prices, '{annual,msrp}',
                        to_jsonb(GREATEST(COALESCE((i.prices->'annual'->>'msrp')::numeric, 0), t.price)))
               ELSE i.prices
             END
FROM target t
WHERE i.id = t.id
RETURNING i.tenant_id, i.id, i.name, i.msrp, i.prices->'annual'->>'msrp' AS annual_msrp;

-- 3. Check the RETURNING rows, then COMMIT (or ROLLBACK).
-- COMMIT;
