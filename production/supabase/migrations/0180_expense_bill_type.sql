-- 0180_expense_bill_type.sql
-- Indian SMEs often incur real expenses with no invoice or only a "kaccha"
-- (informal, non-GST) bill. Those are still deductible for income tax, but
-- carry NO input GST credit (that needs a proper tax invoice). Track how each
-- expense was supported so ITC stays honest and a CA can tell them apart.
--   'gst'    — proper GST tax invoice (input credit claimable)
--   'kaccha' — informal / non-GST bill (no input credit)
--   'none'   — no bill (petty cash etc.; no input credit)

alter table public.expenses
  add column if not exists bill_type text not null default 'gst'
    check (bill_type in ('gst', 'kaccha', 'none'));

comment on column public.expenses.bill_type is 'Supporting document: gst (tax invoice), kaccha (informal/no-GST), none (no bill).';

-- Backfill: anything with GST paid is a GST invoice; the rest had no tax
-- invoice, so mark 'none' (the operator can re-tag kaccha ones later).
update public.expenses set bill_type = case when gst_paid > 0 then 'gst' else 'none' end;
