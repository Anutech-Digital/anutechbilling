-- R-205: how many Google Workspace main rows are below list price (read-only; RAISEs the count).
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM items i
  JOIN (VALUES ('starter', 270), ('standard', 1080), ('plus', 1380)) l(tier, price) ON i.name ILIKE '%' || l.tier || '%'
  WHERE i.vendor = 'google' AND i.kind = 'main' AND i.name ILIKE 'Google Workspace%' AND i.name NOT ILIKE '%enterprise%'
    AND (i.msrp < l.price OR COALESCE((i.prices->'annual'->>'msrp')::numeric, l.price) < l.price);
  RAISE EXCEPTION 'PEEK below_list=%', n;
END $$;
