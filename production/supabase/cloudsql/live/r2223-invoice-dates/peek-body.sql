-- R-2223: read-only count (run.sh wraps it: SET … READ ONLY + DO block that RAISEs "PEEK …").
-- It must print repair=81 cross_month=11 cross_taxable=1400662 on staging before the repair
-- (dry run of 31 Oct 2026), and repair=0 after it.
WITH r AS (
__ROWS__
)
SELECT 'repair=' || count(*) filter (where action = 'repair')
    || ' cross_month=' || count(*) filter (where action = 'repair' and month_changed)
    || ' cross_taxable=' || coalesce(sum(taxable) filter (where action = 'repair' and month_changed), 0)
    || ' same_month=' || count(*) filter (where action = 'repair' and not month_changed)
    || ' same_taxable=' || coalesce(sum(taxable) filter (where action = 'repair' and not month_changed), 0)
    || ' skipped=' || count(*) filter (where action <> 'repair')
    || ' partner_bills=' || count(*) filter (where partner_bill_id is not null)
  INTO r
  FROM r;
IF to_regclass('public.r2223_invoice_date_repair') IS NULL THEN
  r := r || ' undo_rows=none';
ELSE
  EXECUTE 'select $1 || '' undo_rows='' || count(*) from public.r2223_invoice_date_repair' INTO r USING r;
END IF;
