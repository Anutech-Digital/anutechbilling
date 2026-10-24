-- deploy-peek: true
-- (R-1622, 19 Oct: the old peek read storage.buckets, but the PEEK runs as resellersos_migration, which has no
--  USAGE on schema storage on Cloud SQL — "permission denied for schema storage" killed the whole step 2. No
--  catalog object marks this file, so the peek cannot see it; the script skips it and this file is applied BY
--  HAND as postgres (step on card R-1546). It is idempotent. The app gateway enforces the same rule meanwhile.)
-- deploy-key: r1546bucketmime
-- deploy-user: postgres
--   (storage.buckets belongs to the storage admin, as in 20261011133000_r724_storage_roles)
--
-- R-1546 (18 Oct 2026): every bucket names the file types it holds.
--
-- attendance-selfies, employee-docs and expense-receipts had NO type list, so any member
-- could store text/html or SVG there and open it through a signed URL on the app's own
-- origin (its script would run as the app). The storage gateway now refuses markup in
-- every bucket and checks the bytes (src/server/postgrest/storage-safety.ts); this is the
-- same rule in the bucket config, so Supabase Storage enforces it too.
--
-- What the app uploads today:
--   attendance-selfies  camera JPEGs (api/attendance/*)
--   employee-docs       employee documents, reimbursement receipts, vendor bill files
--                       (inputs accept image/* and application/pdf)
--   expense-receipts    public expense-claim photos (JPEG)
-- Existing files are untouched; only new uploads are checked. Idempotent.
do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;

  update storage.buckets
     set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
   where id = 'attendance-selfies';

  update storage.buckets
     set allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']
   where id in ('employee-docs', 'expense-receipts');

  -- logos: raster only (20260901150000_logos_no_svg already did this; restated so a DB
  -- rebuilt from an old dump cannot bring SVG back).
  update storage.buckets
     set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
   where id = 'logos';
end $$;
