-- R-317 PEEK (read-only): active subscriptions with no price (mrr <= 0), and how many of
-- them have a KNOWN edition the catalogue prices. RAISEs one line, changes nothing:
--   PEEK no_price=<n> fixable=<n> fixable_mrr=<rupees> unknown_edition=<n> ambiguous=<n> no_catalog_price=<n> no_seats=<n>
-- The resolution rule is the same as src/lib/subscriptions/list-price-mrr.ts (keep in step with apply.sql):
--   1. item_id -> that catalogue row   2. same planKey (lowercase, punctuation out, "business" dropped)
--   3. google only: the plan names exactly ONE of starter/standard/plus/enterprise and nothing but filler.
--   Two rows priced differently -> ambiguous. Price per seat-month = prices.annual.msrp, else msrp,
--   else prices.annual_total.msrp / 12. Prices come from items; nothing is hardcoded.

CREATE OR REPLACE FUNCTION pg_temp.r317_words(t text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY(SELECT w FROM unnest(string_to_array(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', ' ', 'g'), ' ')) w WHERE w <> '')
$$;
CREATE OR REPLACE FUNCTION pg_temp.r317_key(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT array_to_string(ARRAY(SELECT w FROM unnest(pg_temp.r317_words(t)) w WHERE w <> 'business'), ' ')
$$;
CREATE OR REPLACE FUNCTION pg_temp.r317_edition(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN cardinality(e) = 1 AND e[1] IN ('starter', 'standard', 'plus', 'enterprise') THEN e[1] END
  FROM (SELECT ARRAY(SELECT w FROM unnest(pg_temp.r317_words(t)) w
                     WHERE w NOT IN ('google', 'workspace', 'gsuite', 'g', 'suite', 'business', 'annual', 'yearly',
                                     'monthly', 'flexible', 'flex', 'plan', 'commitment', 'edition', 'subscription')) AS e) x
$$;
CREATE OR REPLACE FUNCTION pg_temp.r317_item_mrr(p_msrp numeric, p_prices jsonb, p_seats int) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN COALESCE((p_prices->'annual'->>'msrp')::numeric, 0) > 0 THEN round((p_prices->'annual'->>'msrp')::numeric * p_seats)::int
    WHEN COALESCE(p_msrp, 0) > 0 THEN round(p_msrp * p_seats)::int
    WHEN COALESCE((p_prices->'annual_total'->>'msrp')::numeric, 0) > 0 THEN round((p_prices->'annual_total'->>'msrp')::numeric * p_seats / 12)::int
  END
$$;

CREATE TEMP VIEW r317_plan AS
WITH cand AS (
  SELECT s.id, s.tenant_id, s.seats, lower(s.vendor::text) AS vendor, s.plan, s.item_id,
         pg_temp.r317_key(s.plan) AS key, pg_temp.r317_edition(s.plan) AS edition
  FROM subscriptions s
  WHERE s.status = 'active' AND s.mrr <= 0
),
cat AS (
  SELECT i.id, i.tenant_id, lower(i.vendor::text) AS vendor, i.kind, i.msrp, i.prices,
         pg_temp.r317_key(i.name) AS key, pg_temp.r317_edition(i.name) AS edition
  FROM items i
  WHERE i.is_active
),
by_item AS (
  SELECT c.id, pg_temp.r317_item_mrr(k.msrp, k.prices, c.seats) AS mrr
  FROM cand c JOIN cat k ON k.id = c.item_id AND k.tenant_id = c.tenant_id
),
by_name AS (
  SELECT c.id, count(DISTINCT x.m) AS d, max(x.m) AS mrr
  FROM cand c
  JOIN cat k ON k.tenant_id = c.tenant_id AND k.vendor = c.vendor AND k.key = c.key AND c.key <> ''
  CROSS JOIN LATERAL (SELECT pg_temp.r317_item_mrr(k.msrp, k.prices, c.seats) AS m) x
  GROUP BY c.id
),
by_edition AS (
  SELECT c.id, count(DISTINCT x.m) AS d, max(x.m) AS mrr
  FROM cand c
  JOIN cat k ON k.tenant_id = c.tenant_id AND k.vendor = 'google' AND k.kind IS DISTINCT FROM 'addon'
            AND k.edition = c.edition
  CROSS JOIN LATERAL (SELECT pg_temp.r317_item_mrr(k.msrp, k.prices, c.seats) AS m) x
  WHERE c.vendor = 'google' AND c.edition IS NOT NULL
  GROUP BY c.id
),
resolved AS (
  SELECT c.id AS sub_id, c.tenant_id, c.plan, c.seats,
    CASE
      WHEN c.seats <= 0 THEN 'no_seats'
      WHEN bi.id IS NOT NULL THEN CASE WHEN bi.mrr IS NULL THEN 'no_catalog_price' ELSE 'item_id' END
      WHEN bn.id IS NOT NULL THEN CASE WHEN bn.d = 0 THEN 'no_catalog_price' WHEN bn.d > 1 THEN 'ambiguous' ELSE 'name' END
      WHEN be.id IS NOT NULL THEN CASE WHEN be.d = 0 THEN 'no_catalog_price' WHEN be.d > 1 THEN 'ambiguous' ELSE 'edition' END
      WHEN c.vendor = 'google' AND c.edition IS NOT NULL THEN 'no_catalog_price'
      ELSE 'unknown_edition'
    END AS via,
    CASE
      WHEN c.seats <= 0 THEN NULL
      WHEN bi.id IS NOT NULL THEN bi.mrr
      WHEN bn.id IS NOT NULL THEN CASE WHEN bn.d = 1 THEN bn.mrr END
      WHEN be.id IS NOT NULL THEN CASE WHEN be.d = 1 THEN be.mrr END
    END AS new_mrr
  FROM cand c
  LEFT JOIN by_item bi ON bi.id = c.id
  LEFT JOIN by_name bn ON bn.id = c.id
  LEFT JOIN by_edition be ON be.id = c.id
)
SELECT * FROM resolved;

DO $$ DECLARE
  n_all int; n_fix int; mrr_fix bigint; n_unknown int; n_amb int; n_noprice int; n_noseats int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE new_mrr > 0),
         COALESCE(sum(new_mrr) FILTER (WHERE new_mrr > 0), 0),
         count(*) FILTER (WHERE via = 'unknown_edition'),
         count(*) FILTER (WHERE via = 'ambiguous'),
         count(*) FILTER (WHERE via = 'no_catalog_price'),
         count(*) FILTER (WHERE via = 'no_seats')
    INTO n_all, n_fix, mrr_fix, n_unknown, n_amb, n_noprice, n_noseats
  FROM pg_temp.r317_plan;
  RAISE EXCEPTION 'PEEK no_price=% fixable=% fixable_mrr=% unknown_edition=% ambiguous=% no_catalog_price=% no_seats=%',
    n_all, n_fix, mrr_fix, n_unknown, n_amb, n_noprice, n_noseats;
END $$;
