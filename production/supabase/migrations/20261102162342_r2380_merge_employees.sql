-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.merge_employees(uuid,uuid,boolean,boolean)') and prosrc like '%R-2380%')
-- deploy-key: r2380mergeemployees
-- 20261102162342_r2380_merge_employees.sql
--
-- R-2380 (2 Nov 2026) — merge two employee records of the same person into one.
--
-- Owner, 2 Nov: "saare Prashant ek hi hai, sabko merge kar do". Staging had the same person as
-- "Prashant" (kept) and "Prashant Kumar" (a duplicate) with salary 2026-07 and 2026-08 on the
-- duplicate — a salary record has no "change employee", only delete, so it could not be moved.
--
-- merge_employees(p_keep_id, p_dup_id, p_keep_both, p_dry_run) — owner / manager / accountant
-- (the payroll group, R-717), both employees in the caller's workspace, ONE transaction (§17b):
--
--   • moves every row keyed by the duplicate's id to the kept one: salary records (their bank
--     reconcile link, incentive, advance recovery and expense id travel with the row), attendance,
--     attendance corrections + devices, leave, documents, assets/property, expense claims,
--     reimbursements, project labour, project tasks, access credentials, assessment attempts;
--     the duplicate's login (users.employee_id) and director link move when the kept record has
--     none (one login / one director per employee). Re-linking a login is owner-only (R-712
--     guard): for another role the login stays and the result says so.
--   • rows that link by TYPED NAME follow too: advances/loans (employee_loans.employee_name) and
--     reimbursements (person_name) whose name equals the duplicate's name, and the salary
--     expense lines (vendor_name / description) of the moved salary records.
--   • copies fields that are EMPTY on the kept record (email, phone, PAN, PF/ESI no, designation,
--     date of birth, address, emergency contact, joining date, biometric id).
--   • marks the duplicate inactive with "Merged into <name> on <date>" in its notes.
--   • writes one activity_log row 'employee.merge' with every count.
--
-- One salary per employee per month (salary_payments unique tenant+employee+period): when both
-- have a salary for the same month the merge is REFUSED with the list of months — unless the
-- caller ticks "keep both — they are different payments". Then both payments stay as separate
-- rows: the clashing month's salary of the duplicate stays on the (now inactive) duplicate
-- record, so nothing is deleted and the unique rule that stops a double salary stays. Same for
-- an attendance day both have, and a project both are on as labour.
--
-- No amount changes anywhere: salary, expense and P&L totals are the same after the merge
-- (supabase/tests/r2380_merge_employees.test.sql). Books lock (R-1584) still applies — a row in
-- a locked month refuses with its own message.
--
-- p_dry_run = true returns the same counts and the clash list without writing (the dialog's
-- preview). Idempotent (create or replace).

begin;

create or replace function public.merge_employees(
  p_keep_id   uuid,
  p_dup_id    uuid,
  p_keep_both boolean default false,
  p_dry_run   boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  /* R-2380 */
  v_tenant   uuid := public.current_tenant_id();
  v_keep     public.employees;
  v_dup      public.employees;
  v_clash    jsonb;
  v_periods  text[];
  v_owner    boolean;
  v_moves    jsonb := '{}'::jsonb;
  v_left     jsonb := '{}'::jsonb;
  v_names    jsonb := '{}'::jsonb;
  v_fields   text[] := '{}';
  v_login    boolean;
  v_director boolean;
  v_n        int;
  v_exp_ids  text[];
  v_note     text;
  v_result   jsonb;
begin
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can merge employees' using errcode = '42501';
  end if;

  if p_keep_id is null or p_dup_id is null then
    raise exception 'Pick both employees' using errcode = 'invalid_parameter_value';
  end if;
  if p_keep_id = p_dup_id then
    raise exception 'Pick a different employee to keep — an employee cannot be merged into itself'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_keep from public.employees where id = p_keep_id for update;
  select * into v_dup  from public.employees where id = p_dup_id  for update;
  if v_keep.id is null or v_dup.id is null then
    raise exception 'Employee not found' using errcode = 'no_data_found';
  end if;
  if v_tenant is null and coalesce(public.current_request_role(), '') in ('anon', 'authenticated') then
    raise exception 'Employee not in your workspace' using errcode = '42501';
  end if;
  v_tenant := coalesce(v_tenant, v_keep.tenant_id);
  if v_keep.tenant_id is distinct from v_tenant or v_dup.tenant_id is distinct from v_tenant then
    raise exception 'Employee not in your workspace' using errcode = '42501';
  end if;

  v_owner := coalesce(public.current_request_role(), '') = 'service_role'
             or public.current_user_has_role('owner');

  -- ── Same-month salary on both: the list, refused unless "keep both" ───────────────────
  select coalesce(jsonb_agg(jsonb_build_object('period', d.period, 'keep_net', k.net, 'dup_net', d.net,
                                               'keep_gross', k.gross, 'dup_gross', d.gross)
                            order by d.period), '[]'::jsonb),
         coalesce(array_agg(d.period), '{}')
    into v_clash, v_periods
    from public.salary_payments d
    join public.salary_payments k
      on k.tenant_id = v_tenant and k.employee_id = p_keep_id and k.period = d.period
   where d.tenant_id = v_tenant and d.employee_id = p_dup_id;

  if jsonb_array_length(v_clash) > 0 and not p_keep_both and not p_dry_run then
    raise exception 'Both employees have a salary for % — one person cannot have two salaries for one month. Undo the wrong one first, or tick "Keep both — they are different payments".',
      (select string_agg(to_char(to_date(p || '-01', 'YYYY-MM-DD'), 'Mon YYYY'), ', ' order by p) from unnest(v_periods) p)
      using errcode = 'check_violation';
  end if;

  -- ── Counts (the preview and the result say the same thing) ─────────────────────────────
  select count(*) into v_n from public.salary_payments
   where tenant_id = v_tenant and employee_id = p_dup_id and period <> all (v_periods);
  v_moves := v_moves || jsonb_build_object('salary', v_n);
  v_left  := v_left  || jsonb_build_object('salary', cardinality(v_periods));

  select count(*) into v_n from public.attendance d
   where d.tenant_id = v_tenant and d.employee_id = p_dup_id
     and not exists (select 1 from public.attendance k
                      where k.tenant_id = v_tenant and k.employee_id = p_keep_id and k.work_date = d.work_date);
  v_moves := v_moves || jsonb_build_object('attendance', v_n);
  select count(*) into v_n from public.attendance d
   where d.tenant_id = v_tenant and d.employee_id = p_dup_id
     and exists (select 1 from public.attendance k
                  where k.tenant_id = v_tenant and k.employee_id = p_keep_id and k.work_date = d.work_date);
  v_left := v_left || jsonb_build_object('attendance', v_n);

  select count(*) into v_n from public.project_labour d
   where d.tenant_id = v_tenant and d.employee_id = p_dup_id
     and not exists (select 1 from public.project_labour k
                      where k.tenant_id = v_tenant and k.employee_id = p_keep_id and k.project_id = d.project_id);
  v_moves := v_moves || jsonb_build_object('project_labour', v_n);
  select count(*) into v_n from public.project_labour d
   where d.tenant_id = v_tenant and d.employee_id = p_dup_id
     and exists (select 1 from public.project_labour k
                  where k.tenant_id = v_tenant and k.employee_id = p_keep_id and k.project_id = d.project_id);
  v_left := v_left || jsonb_build_object('project_labour', v_n);

  v_moves := v_moves
    || jsonb_build_object('leave',            (select count(*) from public.leave_entries          where tenant_id = v_tenant and employee_id = p_dup_id))
    || jsonb_build_object('documents',        (select count(*) from public.employee_documents     where tenant_id = v_tenant and employee_id = p_dup_id))
    || jsonb_build_object('property',         (select count(*) from public.employee_assets        where tenant_id = v_tenant and employee_id = p_dup_id))
    || jsonb_build_object('expense_claims',   (select count(*) from public.expense_claims         where tenant_id = v_tenant and employee_id = p_dup_id))
    || jsonb_build_object('attendance_fixes', (select count(*) from public.attendance_corrections where tenant_id = v_tenant and employee_id = p_dup_id))
    || jsonb_build_object('attendance_devices', (select count(*) from public.attendance_devices   where tenant_id = v_tenant and employee_id = p_dup_id))
    || jsonb_build_object('tasks',            (select count(*) from public.project_tasks          where tenant_id = v_tenant and assignee_employee_id = p_dup_id))
    || jsonb_build_object('credentials',      (select count(*) from public.access_credentials     where tenant_id = v_tenant and holder_employee_id = p_dup_id))
    || jsonb_build_object('assessments',      (select count(*) from public.assessment_attempts    where tenant_id = v_tenant and employee_id = p_dup_id));

  -- Reimbursements: by id, or (no id yet) by the typed person name.
  select count(*) into v_n from public.reimbursements
   where tenant_id = v_tenant
     and (employee_id = p_dup_id
          or (employee_id is null and lower(btrim(person_name)) = lower(btrim(v_dup.name))));
  v_moves := v_moves || jsonb_build_object('reimbursements', v_n);

  -- Advances / loans link by typed name only.
  select count(*) into v_n from public.employee_loans
   where tenant_id = v_tenant and lower(btrim(employee_name)) = lower(btrim(v_dup.name));
  v_names := v_names || jsonb_build_object('advances', v_n);

  -- One login and one director per employee: they move only to a kept record without one.
  v_login := exists (select 1 from public.users where tenant_id = v_tenant and employee_id = p_dup_id)
             and not exists (select 1 from public.users where tenant_id = v_tenant and employee_id = p_keep_id)
             and v_owner;
  v_moves := v_moves || jsonb_build_object('login', case when v_login then 1 else 0 end);
  v_left  := v_left  || jsonb_build_object('login',
               case when not v_login and exists (select 1 from public.users where tenant_id = v_tenant and employee_id = p_dup_id)
                    then 1 else 0 end);
  v_director := exists (select 1 from public.company_directors where tenant_id = v_tenant and employee_id = p_dup_id)
                and not exists (select 1 from public.company_directors where tenant_id = v_tenant and employee_id = p_keep_id);
  v_moves := v_moves || jsonb_build_object('director', case when v_director then 1 else 0 end);

  -- Fields empty on the kept record that the duplicate has.
  if nullif(btrim(coalesce(v_keep.email, '')), '') is null and nullif(btrim(coalesce(v_dup.email, '')), '') is not null then v_fields := v_fields || 'email'::text; end if;
  if nullif(btrim(coalesce(v_keep.phone, '')), '') is null and nullif(btrim(coalesce(v_dup.phone, '')), '') is not null then v_fields := v_fields || 'phone'::text; end if;
  if nullif(btrim(coalesce(v_keep.pan, '')), '') is null and nullif(btrim(coalesce(v_dup.pan, '')), '') is not null then v_fields := v_fields || 'pan'::text; end if;
  if nullif(btrim(coalesce(v_keep.pf_no, '')), '') is null and nullif(btrim(coalesce(v_dup.pf_no, '')), '') is not null then v_fields := v_fields || 'pf_no'::text; end if;
  if nullif(btrim(coalesce(v_keep.esi_no, '')), '') is null and nullif(btrim(coalesce(v_dup.esi_no, '')), '') is not null then v_fields := v_fields || 'esi_no'::text; end if;
  if nullif(btrim(coalesce(v_keep.designation, '')), '') is null and nullif(btrim(coalesce(v_dup.designation, '')), '') is not null
     and v_dup.designation not ilike 'duplicate%' then v_fields := v_fields || 'designation'::text; end if;
  if v_keep.date_of_birth is null and v_dup.date_of_birth is not null then v_fields := v_fields || 'date_of_birth'::text; end if;
  if nullif(btrim(coalesce(v_keep.address, '')), '') is null and nullif(btrim(coalesce(v_dup.address, '')), '') is not null then v_fields := v_fields || 'address'::text; end if;
  if nullif(btrim(coalesce(v_keep.emergency_contact_name, '')), '') is null and nullif(btrim(coalesce(v_dup.emergency_contact_name, '')), '') is not null then v_fields := v_fields || 'emergency_contact_name'::text; end if;
  if nullif(btrim(coalesce(v_keep.emergency_contact_phone, '')), '') is null and nullif(btrim(coalesce(v_dup.emergency_contact_phone, '')), '') is not null then v_fields := v_fields || 'emergency_contact_phone'::text; end if;
  if v_keep.joining_date is null and v_dup.joining_date is not null then v_fields := v_fields || 'joining_date'::text; end if;
  if nullif(btrim(coalesce(v_keep.biometric_id, '')), '') is null and nullif(btrim(coalesce(v_dup.biometric_id, '')), '') is not null then v_fields := v_fields || 'biometric_id'::text; end if;

  v_result := jsonb_build_object(
    'keep', jsonb_build_object('id', v_keep.id, 'name', v_keep.name),
    'dup',  jsonb_build_object('id', v_dup.id,  'name', v_dup.name),
    'clashes', v_clash,
    'moved', v_moves,
    'left', v_left,
    'renamed', v_names,
    'fields', to_jsonb(v_fields),
    'dry_run', p_dry_run);

  if p_dry_run then
    return v_result;
  end if;

  -- ── Move ────────────────────────────────────────────────────────────────────────────────
  select coalesce(array_agg(expense_id) filter (where expense_id is not null), '{}') into v_exp_ids
    from public.salary_payments
   where tenant_id = v_tenant and employee_id = p_dup_id and period <> all (v_periods);

  -- Salary expense lines carry the name as text: they follow their salary record.
  update public.expenses
     set vendor_name = v_keep.name,
         description = replace(description, ' — ' || v_dup.name, ' — ' || v_keep.name)
   where tenant_id = v_tenant and id = any (v_exp_ids) and vendor_name = v_dup.name;
  update public.expenses e
     set vendor_name = v_keep.name,
         description = replace(e.description, ' — ' || v_dup.name, ' — ' || v_keep.name)
   where e.tenant_id = v_tenant and e.payment_method = 'statutory'
     and e.category in ('ESI — Employer', 'PF — Employer') and e.vendor_name = v_dup.name
     and exists (select 1 from public.salary_payments s
                  where s.tenant_id = v_tenant and s.employee_id = p_dup_id and s.period <> all (v_periods)
                    and e.description like '% ' || s.period || ' — %');

  update public.salary_payments set employee_id = p_keep_id
   where tenant_id = v_tenant and employee_id = p_dup_id and period <> all (v_periods);

  update public.attendance d set employee_id = p_keep_id
   where d.tenant_id = v_tenant and d.employee_id = p_dup_id
     and not exists (select 1 from public.attendance k
                      where k.tenant_id = v_tenant and k.employee_id = p_keep_id and k.work_date = d.work_date);

  update public.project_labour d set employee_id = p_keep_id
   where d.tenant_id = v_tenant and d.employee_id = p_dup_id
     and not exists (select 1 from public.project_labour k
                      where k.tenant_id = v_tenant and k.employee_id = p_keep_id and k.project_id = d.project_id);

  update public.leave_entries          set employee_id = p_keep_id where tenant_id = v_tenant and employee_id = p_dup_id;
  update public.employee_documents     set employee_id = p_keep_id where tenant_id = v_tenant and employee_id = p_dup_id;
  update public.employee_assets        set employee_id = p_keep_id where tenant_id = v_tenant and employee_id = p_dup_id;
  update public.expense_claims         set employee_id = p_keep_id where tenant_id = v_tenant and employee_id = p_dup_id;
  update public.attendance_corrections set employee_id = p_keep_id where tenant_id = v_tenant and employee_id = p_dup_id;
  update public.attendance_devices     set employee_id = p_keep_id where tenant_id = v_tenant and employee_id = p_dup_id;
  update public.project_tasks          set assignee_employee_id = p_keep_id where tenant_id = v_tenant and assignee_employee_id = p_dup_id;
  update public.access_credentials     set holder_employee_id = p_keep_id where tenant_id = v_tenant and holder_employee_id = p_dup_id;
  update public.assessment_attempts    set employee_id = p_keep_id where tenant_id = v_tenant and employee_id = p_dup_id;

  update public.reimbursements
     set employee_id = p_keep_id,
         person_name = case when lower(btrim(person_name)) = lower(btrim(v_dup.name)) then v_keep.name else person_name end
   where tenant_id = v_tenant
     and (employee_id = p_dup_id
          or (employee_id is null and lower(btrim(person_name)) = lower(btrim(v_dup.name))));

  update public.employee_loans set employee_name = v_keep.name, updated_at = now()
   where tenant_id = v_tenant and lower(btrim(employee_name)) = lower(btrim(v_dup.name));

  if v_login then
    update public.users set employee_id = p_keep_id where tenant_id = v_tenant and employee_id = p_dup_id;
  end if;
  if v_director then
    update public.company_directors set employee_id = p_keep_id where tenant_id = v_tenant and employee_id = p_dup_id;
  end if;

  -- ── Fields + mark the duplicate ─────────────────────────────────────────────────────────
  v_note := 'Merged into ' || v_keep.name || ' on ' || to_char(public.ist_today(), 'DD Mon YYYY');

  update public.employees d
     set is_active    = false,
         biometric_id = case when 'biometric_id' = any (v_fields) then null else d.biometric_id end,
         notes        = v_note || case when nullif(btrim(coalesce(d.notes, '')), '') is not null then E'\n' || d.notes else '' end,
         updated_at   = now()
   where d.id = p_dup_id;

  update public.employees k
     set email                   = case when 'email' = any (v_fields) then v_dup.email else k.email end,
         phone                   = case when 'phone' = any (v_fields) then v_dup.phone else k.phone end,
         pan                     = case when 'pan' = any (v_fields) then v_dup.pan else k.pan end,
         pf_no                   = case when 'pf_no' = any (v_fields) then v_dup.pf_no else k.pf_no end,
         esi_no                  = case when 'esi_no' = any (v_fields) then v_dup.esi_no else k.esi_no end,
         designation             = case when 'designation' = any (v_fields) then v_dup.designation else k.designation end,
         date_of_birth           = case when 'date_of_birth' = any (v_fields) then v_dup.date_of_birth else k.date_of_birth end,
         address                 = case when 'address' = any (v_fields) then v_dup.address else k.address end,
         emergency_contact_name  = case when 'emergency_contact_name' = any (v_fields) then v_dup.emergency_contact_name else k.emergency_contact_name end,
         emergency_contact_phone = case when 'emergency_contact_phone' = any (v_fields) then v_dup.emergency_contact_phone else k.emergency_contact_phone end,
         joining_date            = case when 'joining_date' = any (v_fields) then v_dup.joining_date else k.joining_date end,
         biometric_id            = case when 'biometric_id' = any (v_fields) then v_dup.biometric_id else k.biometric_id end,
         updated_at              = now()
   where k.id = p_keep_id;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, (select u.id from public.users u where u.id = public.current_user_id()),
          'employee.merge', 'employee', p_keep_id::text,
          left(format('Merged %s into %s', v_dup.name, v_keep.name), 120),
          v_result - 'dry_run');

  return v_result;
end;
$$;

comment on function public.merge_employees(uuid, uuid, boolean, boolean) is
  'R-2380: merge a duplicate employee into the kept one — moves every row keyed by the duplicate (salary, attendance, leave, documents, property, claims, reimbursements, labour, tasks, login/director when free) and name-linked advances, copies empty fields, marks the duplicate inactive "Merged into …", logs employee.merge. Refuses a same-month salary on both unless p_keep_both (then that month stays on the duplicate). p_dry_run = preview only. No amount changes.';

revoke all on function public.merge_employees(uuid, uuid, boolean, boolean) from public, anon;
grant execute on function public.merge_employees(uuid, uuid, boolean, boolean) to authenticated, service_role;

commit;
