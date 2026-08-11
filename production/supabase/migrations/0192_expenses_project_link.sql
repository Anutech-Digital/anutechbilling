-- 0192 — Link an expense to a project, for per-project costing + P&L.
--
-- Project costs reuse the existing `expenses` table (which already has vendor,
-- category, amount, GST, paid/payable, attachment) rather than a new table — so
-- project costs automatically flow into the company P&L's operating-expenses
-- line (no double counting, no drift). A nullable project_id tags the ones that
-- belong to a specific project. ON DELETE SET NULL so deleting a project never
-- deletes the expense record (it just un-tags it).

alter table public.expenses
  add column if not exists project_id uuid null references public.project_sales(id) on delete set null;

create index if not exists expenses_project_id_idx
  on public.expenses (project_id)
  where project_id is not null;

comment on column public.expenses.project_id is 'Optional link to a project_sales row — tags this expense as a cost of that project (per-project P&L). ON DELETE SET NULL.';
