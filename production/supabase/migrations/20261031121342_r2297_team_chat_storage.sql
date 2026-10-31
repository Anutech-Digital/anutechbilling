-- deploy-peek: exists(select 1 from pg_proc where proname='storage_object_allowed' and pronamespace='public'::regnamespace and prosrc like '%R-2297%')
-- deploy-key: r2297chatstorage
-- deploy-user: postgres
-- 20261031121342_r2297_team_chat_storage.sql
--
-- R-2297 (G-TEAMCHAT TC-04, 31 Oct 2026): team chat files live in the private `documents` bucket
-- under {tenant}/chat/{channel_id}/{uuid}_{safe-name} (the path chat_attachments already insists
-- on, R-2294). Before this the chat folder fell into R-724's default documents rule — owner /
-- manager only — so a sales or accounts member could not upload or open a file in their own
-- channel (supabase/tests/team_chat_storage.test.sql case 1 fails on the old function).
--
-- WHAT CHANGES: one new branch in public.storage_object_allowed, BEFORE the documents default:
--   select  public.chat_can_read(channel) — same rule as the chat message rows (R-2294): staff
--           read a public channel; a private channel or a DM only its members (owner included).
--   insert  a member of the channel (public.is_chat_member), uploading as itself (owner = caller).
--   delete  the uploader, or the tenant owner, in a channel they can read.
--   update  never (no replace in place).
--   Any other shape under {tenant}/chat/ is refused, for everyone.
-- The rest of the function is R-724's body unchanged (its only other definition; R-2160 added a
-- separate function for ad-creatives).
--
-- Runs as postgres on Cloud SQL, like R-724 (the function was created there by postgres; the
-- storage policies call it as supabase_storage_admin). postgres is a member of authenticated and
-- of resellersos_migration (cloudsql/01a, 05), so the definer may run chat_can_read /
-- is_chat_member. No storage.* object changes: the peek reads pg_proc only (R-1622: the peek
-- user has no USAGE on schema storage). Idempotent.
-- Test: supabase/tests/team_chat_storage.test.sql (rolled back).

begin;

create or replace function public.storage_object_allowed(p_bucket text, p_name text, p_op text, p_owner uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.current_tenant_id();
  v_parts  text[];
  v_n      int;
  v_folder text;
  v_file   text;
  v_role   text;
  v_emp    uuid;
  v_mine   boolean;
  v_money  boolean;
  v_hr     boolean;
  v_om     boolean;
  v_own    boolean;
  v_chan   uuid;
begin
  /* R-724 (+ R-2297 chat folder). The one rule for who may touch a file in a private bucket. Folder 1 is always the
     caller's tenant; the rest depends on the bucket, the folder and the caller's role. */
  if v_uid is null or v_tenant is null or p_name is null or p_op not in ('select', 'insert', 'update', 'delete') then
    return false;
  end if;

  v_parts := string_to_array(p_name, '/');
  v_n     := coalesce(cardinality(v_parts), 0);
  if v_n < 2 or v_parts[1] <> v_tenant::text or '' = any (v_parts) or '.' = any (v_parts) or '..' = any (v_parts) then
    return false;
  end if;
  v_folder := case when v_n >= 3 then v_parts[2] end;
  v_file   := v_parts[v_n];

  select u.role::text, u.employee_id into v_role, v_emp
    from public.users u where u.id = v_uid and u.is_active;
  if v_role is null then return false; end if;

  v_money := v_role in ('owner', 'manager', 'accountant', 'billing');
  v_hr    := v_role in ('owner', 'manager', 'accountant');
  v_om    := v_role in ('owner', 'manager');
  v_mine  := p_owner is not null and p_owner = v_uid;

  if p_bucket = 'employee-docs' then
    if v_folder in ('vendor-bills', 'reimbursements') then
      return case p_op
        when 'select' then v_money or v_mine
        when 'insert' then v_money or (v_folder = 'vendor-bills' and v_mine)
        when 'delete' then v_hr
        else false
      end;
    end if;
    -- {t}/{employeeId}/… — KYC, salary, letters.
    return case p_op when 'update' then false else v_hr end;

  elsif p_bucket = 'attendance-selfies' then
    if v_folder = '_enroll' then
      return p_op = 'select' and v_hr;
    end if;
    v_own := v_n = 3 and v_emp is not null and left(v_file, 37) = v_emp::text || '_';
    return case p_op
      when 'select' then v_money or v_own
      when 'insert' then v_own
      when 'update' then v_own
      else false
    end;

  elsif p_bucket = 'documents' then
    /* R-2297: team chat files {t}/chat/{channel}/{uuid}_{safe-name} — the channel decides, not
       the role. Read = whoever may read the channel's messages (R-2294 chat_can_read: staff for
       a public channel, members only for a private channel or a DM — the owner included).
       Upload = a member, as itself. Delete = the uploader, or the owner where it can read.
       No replace. Any other shape under chat/ is refused (never the owner/manager default). */
    if v_folder = 'chat' then
      if v_n <> 4
         or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or v_file !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9._-]{1,150}$'
         or position('..' in v_file) > 0 then
        return false;
      end if;
      v_chan := v_parts[3]::uuid;
      return case p_op
        when 'select' then public.chat_can_read(v_chan)
        when 'insert' then v_mine and public.is_chat_member(v_chan)
        when 'delete' then (v_mine or v_role = 'owner') and public.chat_can_read(v_chan)
        else false
      end;
    elsif v_folder = 'feedback' then
      return case p_op
        when 'select' then v_om or v_mine
        when 'insert' then v_mine
        else false
      end;
    elsif v_folder in ('payments', 'inbound-bills') then
      return p_op = 'select' and v_money;
    end if;
    return v_om;

  elsif p_bucket = 'tds-certificates' then
    return v_money;
  end if;

  return false;
end;
$function$;

comment on function public.storage_object_allowed(text, text, text, uuid) is
  'R-724: who may select/insert/update/delete a file in employee-docs, attendance-selfies, documents and tds-certificates — tenant folder AND role (and own employee / own upload where the app needs it). R-2297: documents {tenant}/chat/{channel}/{uuid}_{name} follows the team chat channel (chat_can_read / is_chat_member). Used by the "r724 private files *" policies on storage.objects.';

revoke all on function public.storage_object_allowed(text, text, text, uuid) from public, anon;
grant execute on function public.storage_object_allowed(text, text, text, uuid) to authenticated, service_role, supabase_storage_admin;

commit;
