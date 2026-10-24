-- R-1546 (18 Oct 2026): every bucket names its file types; none allows SVG or HTML.
-- Migration 20261018031506_r1546_storage_mime_allowlists. Self-asserting, rolled back.
--   begin; \i 20261018031506_r1546_storage_mime_allowlists.sql; \i r1546_storage_mime_allowlists.test.sql; rollback;
begin;

do $$
declare
  r record;
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'R-1546: no storage schema here — skipped';
    return;
  end if;

  for r in select id, allowed_mime_types from storage.buckets
            where id in ('attendance-selfies', 'employee-docs', 'expense-receipts', 'logos') loop
    if r.allowed_mime_types is null or cardinality(r.allowed_mime_types) = 0 then
      raise exception 'R-1546: bucket % has no mime list', r.id;
    end if;
  end loop;

  if exists (select 1 from storage.buckets b, unnest(b.allowed_mime_types) m
              where m in ('image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'image/*', 'text/*', '*/*')) then
    raise exception 'R-1546: a bucket still allows markup or a wildcard';
  end if;

  if exists (select 1 from storage.buckets where id = 'employee-docs')
     and not exists (select 1 from storage.buckets where id = 'employee-docs' and 'application/pdf' = any(allowed_mime_types) and 'image/jpeg' = any(allowed_mime_types)) then
    raise exception 'R-1546: employee-docs must still take PDFs and photos';
  end if;

  raise notice 'R-1546: bucket mime lists OK';
end $$;

rollback;
