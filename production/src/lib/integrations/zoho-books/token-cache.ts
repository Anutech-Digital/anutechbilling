/**
 * R-1757 — one Zoho Books access token per tenant, reused until shortly before it expires.
 *
 * R-1749 minted a fresh access token on every use. Zoho allows only about ten per refresh
 * token in ten minutes, then refuses; a long Import-from-Zoho dry run (R-1753) hit that and
 * was told "access has ended" although access was fine.
 *
 *   1. memory (this server instance) — keyed by tenant AND a hash of the refresh token, so a
 *      reconnect never reuses the old connection's token;
 *   2. the tenant's own tenant_secrets row (sealed, with its expiry) — shared by every
 *      instance, so a second instance does not mint again;
 *   3. otherwise mint ONE (single-flight: callers that arrive meanwhile wait for the same one),
 *      store it in both, and use it until EARLY_MS before it expires.
 * Server-only. The token never reaches a browser.
 */
import { createHash } from "node:crypto";
import { mintAccessToken } from "./api";
import type { ZohoCreds } from "./config";

/** Stop using a token this long before Zoho's expiry. */
export const EARLY_MS = 60_000;

export interface CachedToken { token: string; expiresAt: number; rt: string }
export interface TokenStore {
  read(): Promise<{ token: string; expiresAt: number; rt?: string } | null>;
  write(t: { token: string; expiresAt: number }): Promise<void>;
  clear(): Promise<void>;
}

const memory = new Map<string, CachedToken>();
const inFlight = new Map<string, Promise<string>>();

const rtHash = (refreshToken: string) => createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);

/** Test hook and the reconnect / disconnect path: forget the cached token of one tenant. */
export function forgetAccessToken(tenantId: string): void {
  memory.delete(tenantId);
}

export async function getAccessToken(
  tenantId: string,
  refreshToken: string,
  creds: ZohoCreds,
  store: TokenStore,
  opts: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  const rt = rtHash(refreshToken);
  const fresh = (t: { expiresAt: number } | null | undefined) => Boolean(t && t.expiresAt - EARLY_MS > now());

  const mem = memory.get(tenantId);
  if (mem && mem.rt === rt && fresh(mem)) return mem.token;

  const key = `${tenantId}:${rt}`;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const p = (async () => {
    const stored = await store.read().catch(() => null);
    if (stored && fresh(stored)) {
      memory.set(tenantId, { token: stored.token, expiresAt: stored.expiresAt, rt });
      return stored.token;
    }
    const minted = await mintAccessToken(refreshToken, creds, opts.fetch);
    const expiresAt = now() + minted.expiresInSec * 1000;
    memory.set(tenantId, { token: minted.token, expiresAt, rt });
    /* Shared with the other instances; a failed write only costs them one extra mint. */
    await store.write({ token: minted.token, expiresAt }).catch(() => undefined);
    return minted.token;
  })();
  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
}

/** Zoho refused the cached token (401): drop it everywhere so the next call mints a new one. */
export async function invalidateAccessToken(tenantId: string, store: TokenStore): Promise<void> {
  memory.delete(tenantId);
  await store.clear().catch(() => undefined);
}
