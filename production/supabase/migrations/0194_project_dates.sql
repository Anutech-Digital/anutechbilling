-- 0194 — Project start + target (deadline) dates.
--
-- A project runs over a period; knowing start → target lets us show timeline /
-- days-left / overdue, and drive costing automation (e.g., default a labour
-- allocation's months to the project's real duration). Both nullable — existing
-- projects simply have no dates until set.

alter table public.project_sales
  add column if not exists start_date  date null,
  add column if not exists target_date date null;

comment on column public.project_sales.start_date  is 'When work on the project began (nullable).';
comment on column public.project_sales.target_date is 'Target completion / deadline (nullable). Drives days-left / overdue + labour duration default.';
