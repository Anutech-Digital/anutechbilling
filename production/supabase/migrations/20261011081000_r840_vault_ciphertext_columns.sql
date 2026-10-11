-- deploy-key: r840vaultcols
-- deploy-peek: (not exists(select 1 from pg_attribute a where a.attrelid = to_regclass('public.vault_passwords') and a.attname in ('username_ciphertext', 'password_ciphertext', 'notes_ciphertext') and not a.attisdropped and (has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT') or has_column_privilege('anon', a.attrelid, a.attnum, 'SELECT') or has_column_privilege('authenticated', a.attrelid, a.attnum, 'INSERT') or has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE'))) and exists(select 1 from pg_attribute a where a.attrelid = to_regclass('public.vault_passwords') and a.attname = 'title' and has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT')))
-- 20261011081000_r840_vault_ciphertext_columns.sql
--
-- R-840 (11 Oct 2026, security p1). Found by the R-716 worker.
--
-- ══ WHAT WAS OPEN ═══════════════════════════════════════════════════════════════
--   vault_passwords.username_ciphertext / password_ciphertext / notes_ciphertext hold the
--   customers' admin-console logins (Google Admin, M365, registrar), encrypted with
--   SECRETS_MASTER_KEY. The baseline gives `authenticated` column SELECT on the other columns
--   only — but supabase/cloudsql/09-grant-what-policies-allow.sql (staging deploy-db step 3b)
--   saw "no table-level SELECT" and granted TABLE-level SELECT on every run, so any owner /
--   manager session (R-716 policies) could pull the ciphertext straight through REST: an
--   offline copy of every credential, in the browser cache and in any HAR file.
--   Table-level INSERT / UPDATE also let a browser session overwrite a ciphertext directly.
--
--   The other half: on a DB with only the baseline column grants, /api/vault/[id]/reveal read
--   the ciphertext with the user's client and got "permission denied" — reveal broke for the
--   owner too.
--
-- ══ WHAT THIS DOES ══════════════════════════════════════════════════════════════
--   The three *_ciphertext columns are now server-only (service_role). The routes read and write
--   them with the admin client AFTER vaultGate() (owner / manager), tenant-scoped by
--   tenant_id = caller's tenant (R-840, src/app/api/vault). 09 lists them in secret_cols, so a
--   later deploy-db run cannot hand them back.
--     authenticated  SELECT  every column except the three ciphertexts (what the list shows)
--                    INSERT  tenant_id, customer_id, title, category, url, last_rotated_at,
--                            created_by (no ciphertext, no fingerprint — the API writes those)
--                    UPDATE  customer_id, title, category, url, updated_at
--                    DELETE  kept (RLS: owner / manager of the tenant)
--                    TRUNCATE / TRIGGER / REFERENCES  revoked (TRUNCATE ignores RLS)
--     anon           nothing (R-716 already revoked; repeated so a fresh DB matches)
--   RLS policies (vault_passwords_*_om, R-716) are unchanged.
--   Test: supabase/tests/r840_vault_ciphertext_hidden.test.sql.

begin;

revoke all on table public.vault_passwords from anon;

-- REVOKE on the table also drops this role's column grants; everything needed is granted back.
revoke select, insert, update, truncate, trigger, references on table public.vault_passwords from authenticated;
revoke select (username_ciphertext, password_ciphertext, notes_ciphertext),
       insert (username_ciphertext, password_ciphertext, notes_ciphertext),
       update (username_ciphertext, password_ciphertext, notes_ciphertext)
  on public.vault_passwords from authenticated;

grant select (id, tenant_id, customer_id, title, category, url, password_fingerprint,
              last_rotated_at, created_by, created_at, updated_at)
  on public.vault_passwords to authenticated;
grant insert (tenant_id, customer_id, title, category, url, last_rotated_at, created_by)
  on public.vault_passwords to authenticated;
grant update (customer_id, title, category, url, updated_at)
  on public.vault_passwords to authenticated;
grant delete on public.vault_passwords to authenticated;

grant all on table public.vault_passwords to service_role;

commit;
