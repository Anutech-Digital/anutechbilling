/**
 * R-1979: the Conversions API token, opened from its vault envelope (tenant-secrets.ts seals it).
 * An envelope that cannot be opened (wrong key) reads as "no token" — the event is skipped and
 * logged, never thrown into an order.
 */
import { decryptSecret } from "@/lib/crypto/vault";

export function openSecret(stored: string | null | undefined): string | null {
  try {
    const v = decryptSecret(stored);
    return v && v.trim() ? v.trim() : null;
  } catch (e) {
    console.error("[meta/capi] token could not be opened:", e instanceof Error ? e.message : e);
    return null;
  }
}
