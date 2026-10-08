/**
 * Google OAuth refresh tokens, encrypted at rest (R-051 part 2, 7 Oct 2026).
 *
 * `user_google_tokens.refresh_token` was stored in PLAINTEXT. A refresh token is
 * a long-lived key to someone's Gmail (send + read), Contacts, Business Profile
 * and Ads — anyone with read access to that one table, a DB dump or a leaked
 * service-role key could mail as the business. Same envelope as tenant_secrets
 * (lib/crypto/vault.ts, SECRETS_MASTER_KEY), same column, no migration: the
 * stored string is the `rosv1:` envelope instead of the raw token.
 *
 * ── RULES ────────────────────────────────────────────────────────────────────
 * - WRITE (OAuth callbacks): `sealRefreshToken` — throws VaultNotConfiguredError
 *   without a key. Never stored in the clear.
 * - READ: only `refreshAccessToken` (lib/google/oauth.ts) opens it, server-side,
 *   right before calling Google. Status routes only ever test `Boolean(...)`, which
 *   is the same for ciphertext — the token itself never reaches the browser.
 * - LEGACY rows written before this are plaintext. They keep working (decrypt
 *   passes plaintext through) and are sealed on the next write to the row
 *   (`resealIfPlain` rides along with the access-token update), so there is no
 *   bulk rewrite.
 *
 * Server-only (node:crypto through vault.ts).
 */
import {
  decryptSecret, encryptSecret, isEncrypted, isVaultConfigured, VAULT_NOT_CONFIGURED_MESSAGE,
} from "@/lib/crypto/vault";

/**
 * OAuth callbacks call this BEFORE exchanging the code: with no master key the
 * token could not be stored safely, so the connect is refused up front (the code
 * is not burned, and the log says what to fix — the variable name, never a value).
 * Returns true when the caller must stop.
 */
export function refuseConnectWithoutVault(route: string): boolean {
  if (isVaultConfigured()) return false;
  console.error(`[${route}] ${VAULT_NOT_CONFIGURED_MESSAGE}`);
  return true;
}

/** Encrypt a fresh refresh token for storage. Throws when no master key is set. */
export function sealRefreshToken(token: string): string {
  return isEncrypted(token) ? token : encryptSecret(token);
}

/**
 * The usable token from a stored value — envelope or legacy plaintext.
 * Throws when it IS an envelope that cannot be opened (missing/wrong key), so the
 * caller reports a key problem instead of sending Google garbage.
 */
export function openRefreshToken(stored: string | null | undefined): string | null {
  return decryptSecret(stored);
}

/**
 * Patch fragment that upgrades a legacy plaintext token on the next write.
 * Empty when it is already sealed, absent, or this server has no key (then the
 * row simply stays as it was — reading it still works).
 */
export function resealIfPlain(stored: string | null | undefined): { refresh_token?: string } {
  if (!stored || isEncrypted(stored) || !isVaultConfigured()) return {};
  return { refresh_token: encryptSecret(stored) };
}
