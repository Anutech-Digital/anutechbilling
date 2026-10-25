/**
 * Meta Ads long-lived tokens, encrypted at rest (R-1884, 25 Oct 2026).
 *
 * `ad_accounts.access_token` was written in PLAINTEXT by the Meta connect callback — hidden
 * from browser roles by a column grant (R-833) but readable by anyone with a DB dump or the
 * service-role key, while the Google refresh token next to it was already sealed (R-051).
 * Same envelope (lib/crypto/vault.ts, SECRETS_MASTER_KEY, "rosv1:"), same column, no
 * migration — this mirrors lib/google/token-vault.ts.
 *
 * - WRITE (meta-ads/callback): `sealMetaToken` — throws VaultNotConfiguredError without a
 *   key, so the token is never stored in the clear.
 * - READ: only the spend sync (lib/marketing/ad-sync.ts) opens it, server-side, right before
 *   calling Meta. The status route never selects the column.
 * - LEGACY plaintext rows keep working (decrypt passes plaintext through) and are sealed on
 *   that account's next successful sync write (`resealMetaTokenIfPlain`). Nothing is
 *   rewritten in bulk, so a token can never be lost to a half-run migration.
 *
 * Server-only (node:crypto through vault.ts).
 */
import { decryptSecret, encryptSecret, isEncrypted, isVaultConfigured } from "@/lib/crypto/vault";

/** Encrypt a fresh Meta token for storage. Throws when no master key is set. */
export function sealMetaToken(token: string): string {
  return isEncrypted(token) ? token : encryptSecret(token);
}

/** The usable token from a stored value (envelope or legacy plaintext). Throws on an unopenable envelope. */
export function openMetaToken(stored: string | null | undefined): string | null {
  return decryptSecret(stored);
}

/** Patch fragment that seals a legacy plaintext row on the next write; empty otherwise. */
export function resealMetaTokenIfPlain(stored: string | null | undefined): { access_token?: string } {
  if (!stored || isEncrypted(stored) || !isVaultConfigured()) return {};
  return { access_token: encryptSecret(stored) };
}
