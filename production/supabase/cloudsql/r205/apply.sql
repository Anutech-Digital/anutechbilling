-- R-205 (6 Oct 2026): raise Google Workspace list prices (msrp + prices.annual.msrp) to
-- Starter 270 / Standard 1080 / Plus 1380 per seat-month. Cost, flexible tier and rows already
-- at or above list are untouched. Same statement as scripts/ops/r205-gw-list-prices.sql step 2.
BEGIN;
WITH list(tier, price) AS (VALUES ('starter', 270), ('standard', 1080), ('plus', 1380)),
target AS (
  SELECT i.id, l.price FROM items i JOIN list l ON i.name ILIKE '%' || l.tier || '%'
  WHERE i.vendor = 'google' AND i.kind = 'main' AND i.name ILIKE 'Google Workspace%' AND i.name NOT ILIKE '%enterprise%'
    AND (i.msrp < l.price OR COALESCE((i.prices->'annual'->>'msrp')::numeric, l.price) < l.price)
)
UPDATE items i
SET msrp = GREATEST(i.msrp, t.price),
    prices = CASE WHEN i.prices ? 'annual'
                  THEN jsonb_set(i.prices, '{annual,msrp}', to_jsonb(GREATEST(COALESCE((i.prices->'annual'->>'msrp')::numeric, 0), t.price)))
                  ELSE i.prices END
FROM target t WHERE i.id = t.id;
COMMIT;
