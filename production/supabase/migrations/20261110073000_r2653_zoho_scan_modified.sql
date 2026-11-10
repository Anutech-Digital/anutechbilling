-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'zoho_fy_scan' and column_name = 'zoho_modified') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'zoho_fy_scan' and column_name = 'deposit_account_id') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'zoho_fy_scan_runs' and column_name = 'list_started_at') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'zoho_fy_scan_runs' and column_name = 'only_account_id') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'zoho_fy_scan' and column_name = 'facts_version')
-- deploy-key: r2653zohoscanmodified
--
-- R-2653 (10 Nov 2026, G-RECON N1): "Read from Zoho again" forgot the whole FY scan and read every
-- document's detail again (2,780 invoices twice on 10 Nov, 2,576 receipts) — two readers spent Zoho's
-- daily API limit by 04:24Z. Now Read again lists the FY again (list calls only) and reads the detail
-- only of documents that are new or changed in Zoho.
--
-- ══ WHAT THIS ADDS (server only — service_role; R-2499's RLS unchanged) ═══════════════════════════
--   zoho_fy_scan.zoho_modified        — Zoho's last_modified_time from the list row, as Zoho sent it.
--                                       A different value on the next list = changed → detail again.
--   zoho_fy_scan.deposit_account_id   — the Zoho account a customer payment was deposited to (list row),
--                                       so Read again can be limited to one account (Razorpay Clearing).
--   zoho_fy_scan.facts_version        — which version of the kind's normaliser made the stored facts
--                                       (fy-import/scan.ts SCAN_FACTS_VERSION); older → read again.
--   zoho_fy_scan_runs.list_started_at — when this Read again's listing began; rows not listed since get
--                                       their detail read again when the list finishes (404 → dropped).
--   zoho_fy_scan_runs.only_account_id — this read is limited to one Zoho deposit account (null = all).
-- Zoho is only read. Nothing is imported. Plain columns, no function; rollback = drop the columns.

alter table public.zoho_fy_scan
  add column if not exists zoho_modified      text check (zoho_modified is null or char_length(zoho_modified) <= 60),
  add column if not exists deposit_account_id text check (deposit_account_id is null or char_length(deposit_account_id) <= 60),
  add column if not exists facts_version      smallint check (facts_version is null or facts_version >= 0);

alter table public.zoho_fy_scan_runs
  add column if not exists list_started_at timestamptz,
  add column if not exists only_account_id text check (only_account_id is null or char_length(only_account_id) <= 60);

comment on column public.zoho_fy_scan.zoho_modified is
  'R-2653: Zoho''s last_modified_time from the list row; a different value on Read again = changed in Zoho → its detail is read again.';
comment on column public.zoho_fy_scan.deposit_account_id is
  'R-2653: the Zoho deposit account of a customer payment (list row) — Read again can be limited to one account.';
comment on column public.zoho_fy_scan.facts_version is
  'R-2653: the normaliser version that made payload (null = before R-2653 = 0); older than the code''s → Read again reads the detail again.';
comment on column public.zoho_fy_scan_runs.list_started_at is
  'R-2653: when this Read again''s listing began; rows not listed since get their detail read again (404 = gone from Zoho → dropped).';
comment on column public.zoho_fy_scan_runs.only_account_id is
  'R-2653: this read is limited to one Zoho deposit account (customer payments); null = all accounts.';
