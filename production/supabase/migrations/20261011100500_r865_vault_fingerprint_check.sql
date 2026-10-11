-- deploy-key: r865vaultfp
-- deploy-peek: exists(select 1 from pg_constraint where conname = 'vault_passwords_password_fingerprint_check' and conrelid = to_regclass('public.vault_passwords') and pg_get_constraintdef(oid) like '%<= 64%')
-- 20261011100500_r865_vault_fingerprint_check.sql
--
-- R-865 (P1 bug, AI tester 11 Oct 2026): the owner could not save ANY vault credential while
-- SECRETS_MASTER_KEY was set — "violates check constraint vault_passwords_password_fingerprint_check".
--
-- Cause: fingerprintPassword() (src/lib/crypto/vault.ts) returns a full HMAC-SHA256 hex digest
-- = 64 chars, but 0234 / baseline.sql allowed length(password_fingerprint) <= 32.
--
-- Which side is right: the code. The fingerprint is used only to spot the same password reused
-- across entries (/api/vault health → equality on the whole value). A full 256-bit HMAC is the
-- intended value (keyed, so a leaked table cannot be wordlisted; truncating buys nothing and
-- raises collision odds). So the check is widened to 64. NULL stays allowed (no key configured
-- → the route stores NULL by design). Not forced to hex: existing tests/dummy rows use short
-- non-hex markers, and the length bound is what protects the column.
--
-- Data: no row can hold a value > 32 today (the old check refused them), so every existing row
-- already satisfies <= 64 — nothing to fix. R-716 RLS / R-840 column grants are untouched.

alter table public.vault_passwords
  drop constraint if exists vault_passwords_password_fingerprint_check;

alter table public.vault_passwords
  add constraint vault_passwords_password_fingerprint_check
  check (password_fingerprint is null or char_length(password_fingerprint) <= 64);

comment on column public.vault_passwords.password_fingerprint is
  'Keyed HMAC-SHA256 (hex, 64 chars) of the password, for detecting reuse across entries without storing anything a leak could crack. Never a substitute for the ciphertext.';
