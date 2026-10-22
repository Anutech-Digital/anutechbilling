-- R-1740: contacts.relationship_type + closeness, and the one-time mapping of the old
-- contacts.relationship values. Run in ONE rolled-back transaction WITH the migration:
--   begin; <migration> <this file>   (the file's own rollback; at the end undoes both)
-- The mapping is exercised by re-running the migration's own UPDATE over rows written the
-- pre-R-1740 way (relationship set, relationship_type left at its default).
-- Every check raises on FAIL; exit 0 = pass. Without the migration it fails at the first
-- insert (column relationship_type does not exist).
-- The file wraps itself in begin; ... rollback; (scripts/test-sql.mjs refuses any test that
-- does not roll back), so its rows never stay behind on the database it runs against.
begin;

do $$
declare
  v_tenant uuid := (select id from public.tenants order by created_at limit 1);
  v_t text; v_c text;
begin
  if v_tenant is null then raise exception 'FAIL setup: no tenant in this database'; end if;

  -- Owner example 3: old contacts, written the way the app wrote them before R-1740.
  insert into public.contacts (id, tenant_id, full_name, source, relationship, relationship_type) values
    ('C-R1740-P', v_tenant, 'Old Partner',  'manual', 'partner',  'unknown'),
    ('C-R1740-V', v_tenant, 'Old Vendor',   'manual', 'vendor',   'unknown'),
    ('C-R1740-E', v_tenant, 'Old Employee', 'manual', 'employee', 'unknown'),
    ('C-R1740-S', v_tenant, 'Old Personal', 'manual', 'personal', 'unknown'),
    ('C-R1740-O', v_tenant, 'Old Other',    'manual', 'other',    'unknown');

  -- The migration's mapping, verbatim (it only touches rows still at the default).
  update public.contacts
     set relationship_type = case lower(btrim(relationship))
                               when 'partner'  then 'partner'
                               when 'vendor'   then 'vendor'
                               when 'employee' then 'colleague'
                               when 'personal' then 'friend'
                               else 'unknown'
                             end
   where relationship is not null
     and btrim(relationship) <> ''
     and relationship_type = 'unknown';

  select relationship_type into v_t from public.contacts where id = 'C-R1740-P';
  if v_t <> 'partner' then raise exception 'FAIL partner -> %', v_t; end if;
  select relationship_type into v_t from public.contacts where id = 'C-R1740-V';
  if v_t <> 'vendor' then raise exception 'FAIL vendor -> %', v_t; end if;
  select relationship_type into v_t from public.contacts where id = 'C-R1740-E';
  if v_t <> 'colleague' then raise exception 'FAIL employee -> %', v_t; end if;
  select relationship_type into v_t from public.contacts where id = 'C-R1740-S';
  if v_t <> 'friend' then raise exception 'FAIL personal -> %', v_t; end if;
  select relationship_type into v_t from public.contacts where id = 'C-R1740-O';
  if v_t <> 'unknown' then raise exception 'FAIL other -> %', v_t; end if;

  -- Owner example 2: a fresh lead's anchor contact with nothing chosen is 'unknown', never null.
  insert into public.contacts (id, tenant_id, full_name, source) values ('C-R1740-N', v_tenant, 'Cold Lead', 'enquiry');
  select relationship_type, closeness into v_t, v_c from public.contacts where id = 'C-R1740-N';
  if v_t is distinct from 'unknown' or v_c is not null then raise exception 'FAIL default: % / %', v_t, v_c; end if;

  -- Owner example 1: Rahul = Friend, Close saves.
  update public.contacts set relationship_type = 'friend', closeness = 'close' where id = 'C-R1740-N';
  select relationship_type, closeness into v_t, v_c from public.contacts where id = 'C-R1740-N';
  if v_t <> 'friend' or v_c <> 'close' then raise exception 'FAIL save: % / %', v_t, v_c; end if;

  -- Values outside the lists are refused (asserting the constraint by name).
  begin
    update public.contacts set relationship_type = 'enemy' where id = 'C-R1740-N';
    raise exception 'FAIL bad relationship_type accepted';
  exception when check_violation then
    if sqlerrm not like '%contacts_relationship_type_check%' then raise; end if;
  end;
  begin
    update public.contacts set closeness = 'very' where id = 'C-R1740-N';
    raise exception 'FAIL bad closeness accepted';
  exception when check_violation then
    if sqlerrm not like '%contacts_closeness_check%' then raise; end if;
  end;
  begin
    update public.contacts set relationship_type = null where id = 'C-R1740-N';
    raise exception 'FAIL null relationship_type accepted';
  exception when not_null_violation then null;
  end;

  raise notice 'R-1740 contact relationship: all checks passed';
end $$;

rollback;
