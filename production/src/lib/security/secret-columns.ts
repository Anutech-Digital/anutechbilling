/**
 * Secret columns — ONE list, shared (R-833 list, moved here by R-2774 on 14 Nov 2026).
 *
 * secret-columns.test.ts proves this list equals `secret_cols` in
 * supabase/cloudsql/09-grant-what-policies-allow.sql and get_tenant_backup's strip list, and that
 * every secret-LOOKING column (SECRET_NAME) is either here or reviewed there with a reason.
 * The Help AI tool layer (src/lib/ai/help-tools/reader.ts) refuses to select any of these columns
 * and any column whose name matches SECRET_NAME — even where the owner's own login could read it.
 */

/** table.column that no browser role (authenticated / anon) may read. Same list as 09. */
export const SECRET_COLUMNS: readonly string[] = [
  "attendance_settings.presence_secret",
  "attendance_settings.ingest_key",
  "employees.pin_hash",
  "ad_accounts.access_token",
  "user_google_tokens.access_token",
  "user_google_tokens.refresh_token",
  "user_google_tokens.sync_token",
  "email_verifications.token_hash",
  // R-840: customers' admin-console logins (encrypted). Server-only: the vault routes read and
  // write them with the admin client after vaultGate() (owner / manager).
  "vault_passwords.username_ciphertext",
  "vault_passwords.password_ciphertext",
  "vault_passwords.notes_ciphertext",
];

/** A column name that looks like a credential. */
export const SECRET_NAME = /(secret|token|password|passcode|_hash$|api_key|ingest_key|private_key|credential)/i;
