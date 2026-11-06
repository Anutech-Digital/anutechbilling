-- deploy-peek: case when exists (select 1 from pg_roles where rolname = 'anon') then not has_function_privilege('anon', 'public.current_user_is_owner()', 'execute') else true end
-- deploy-key: r2477revokeanonisowner
-- 20261105165200_r2477_revoke_anon_is_owner.sql
--
-- R-2477 follow-up (SQL CI red on 6133df906: anon_default_privileges FAIL 3). The R-2477 migration
-- dropped users_tenant_delete, the last policy that called current_user_is_owner(). A SECURITY
-- DEFINER function used by no policy must not be executable by anon (anon_default_privileges case
-- 3); it was only allowed before because a policy referenced it. Nothing anonymous needs it: it
-- answers "is the signed-in login an owner of the selected company" and is false without a login.
-- authenticated keeps EXECUTE (app code + other definer functions call it). Idempotent; a database
-- without an anon role (Cloud SQL) is left as it is.

begin;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.current_user_is_owner() from anon;
  end if;
end $$;

commit;
