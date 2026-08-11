-- 0204 — Free-text comment / notes on an expense.
--
-- The short `description` ("Kis liye?") is a one-liner. This adds a longer
-- free-text comment for extra context — e.g. "Ranjeet ka birthday gift; company
-- transferred to Prateek's a/c, Prateek gave cash to Ranjeet". Optional.

alter table public.expenses add column if not exists notes text;
comment on column public.expenses.notes is 'Free-text comment / extra detail about the expense (context, who/why/how). Separate from the short description.';
