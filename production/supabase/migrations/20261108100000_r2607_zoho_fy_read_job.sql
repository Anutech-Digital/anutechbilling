-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'zoho_fy_scan_runs' and column_name = 'bg_requested_at') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'zoho_fy_scan_runs' and column_name = 'bg_lease_until')
-- deploy-key: r2607zohofyreadjob
--
-- R-2607 (8 Nov 2026): Invoices → "FY 2025-26 receipts from Zoho" → "Read from Zoho again" read the
-- year (2,576 payments, ~35 min) only while the browser tab stayed open and in front: the tab froze
-- at 87/2,576 and Chrome replaced it twice — nothing read, nothing imported.
--
-- The scan itself was already the server's (zoho_fy_scan_runs / zoho_fy_scan, R-2499) and resumable;
-- only the LOOP lived in the browser. Now the server runs it: the dialog asks for the read
-- (bg_requested_at), a server pass (cron zoho-fy-read, every minute, and the open dialog) takes a
-- lease, reads the next pages / details under Zoho's pace, saves after every call and lets go.
--
-- ══ WHAT THIS ADDS (zoho_fy_scan_runs, server only — service_role, R-2499's RLS unchanged) ═══════
--   bg_requested_at / bg_requested_by — an owner / accountant asked for the read; cleared when the
--                                       read is complete or stopped for a reason the owner must fix.
--   bg_lease_until                    — a pass is running until then (one pass per company + list +
--                                       year; a crashed pass's lease runs out and the next carries on).
--   bg_error / bg_finished_at / bg_last_step_at — what the dialog shows (why it stopped, when done,
--                                       when it last moved).
-- Zoho is only read. Nothing is imported: Check + Import stay the owner's buttons (R-2501).
-- Plain columns, no function; rollback = drop the columns.

alter table public.zoho_fy_scan_runs
  add column if not exists bg_requested_at timestamptz,
  add column if not exists bg_requested_by uuid,
  add column if not exists bg_lease_until  timestamptz,
  add column if not exists bg_error        text check (bg_error is null or char_length(bg_error) <= 500),
  add column if not exists bg_finished_at  timestamptz,
  add column if not exists bg_last_step_at timestamptz;

comment on column public.zoho_fy_scan_runs.bg_requested_at is
  'R-2607: the read was asked for (dialog); the server job reads until complete. Null = not asked / finished.';
comment on column public.zoho_fy_scan_runs.bg_lease_until is
  'R-2607: a server pass holds this run until then — a second pass does nothing.';

-- The cron finds the asked-for reads of every company.
create index if not exists zoho_fy_scan_runs_bg_requested_idx
  on public.zoho_fy_scan_runs (bg_requested_at) where bg_requested_at is not null;
