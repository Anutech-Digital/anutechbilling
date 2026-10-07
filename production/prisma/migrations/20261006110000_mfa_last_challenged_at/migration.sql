-- R-161 (6 Oct 2026): src/server/auth/mfa.ts reads and writes auth.mfa_factors.last_challenged_at
-- (one TOTP code accepted once). Newer GoTrue has the column; the GoTrue on our VMs is older, so
-- staging's table lacked it and every Auth.js Google sign-in failed with 42703 before a session
-- was made. Nullable and additive: the VM's GoTrue keeps working while it is still running.
begin;
alter table auth.mfa_factors add column if not exists last_challenged_at timestamptz;
commit;
