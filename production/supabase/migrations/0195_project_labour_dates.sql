-- 0195 — Give each project-labour allocation its own period (from → to).
--
-- So we can show "kab se kab tak" per employee and derive the months (and thus
-- the cost) from the real period. Both nullable — older rows just keep `months`.
-- Cost stays = monthly_gross × percent% × months; when dates are set, months is
-- derived from (end − start).

alter table public.project_labour
  add column if not exists start_date date null,
  add column if not exists end_date   date null;

comment on column public.project_labour.start_date is 'When this person started on the project (nullable; defaults to project start).';
comment on column public.project_labour.end_date   is 'When this person''s stint ends (nullable; defaults to project target).';
