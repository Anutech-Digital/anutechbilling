/**
 * Read/write helpers for `tenant_secrets`, with envelope decryption applied.
 *
 * Secrets are read in roughly a dozen places. If each one remembered to call
 * `decryptSecret` itself, the first site that forgot would hand a caller an
 * envelope string as an API key — and the failure would surface as a confusing
 * 401 from Razorpay or Google, not as an obvious local bug. So the decryption
 * lives here, keyed off a list of column names, and call sites pass the row
 * through rather than reasoning about it.
 *
 * The allow-list is deliberate. Decrypting every string field would try to open
 * `razorpay_mode` and `gemini_model`, which are configuration, not secrets.
 */
import { decryptSecret, encryptSecret, isEncrypted, VaultNotConfiguredError } from "./vault";

/**
 * Columns of tenant_secrets that hold credentials.
 *
 * ADD NEW SECRET COLUMNS HERE. A credential missing from this list is stored and
 * read in the clear while everything looks normal — which is precisely the state
 * the vault exists to end.
 */
export const SECRET_COLUMNS = [
  "razorpay_key_secret",
  "razorpay_webhook_secret",
  "gemini_api_key",
  "whatsapp_access_token",
  "whatsapp_app_secret",
  "whatsapp_verify_token",
  "sandbox_api_secret",
  // Per-tenant sending key. Until 0237 there was only the deployment-wide
  // RESEND_API_KEY env var, which meant every tenant sent through one account:
  // one bill, one domain reputation, and one tenant's spam complaint degrading
  // delivery for all of them.
  "resend_api_key",
  // S34 — IndiaMART Lead Manager CRM key (migration 20260928151000).
  "indiamart_crm_key",
] as const;

const SECRET_SET = new Set<string>(SECRET_COLUMNS);

/**
 * Decrypt every credential field on a tenant_secrets row.
 *
 * Plaintext passes through untouched (see vault.ts), so this is safe to apply to
 * rows written before encryption existed. A field that IS an envelope but cannot
 * be opened throws — deliberately, because silently returning null there would
 * disable a tenant's integration with no explanation.
 */
export function decryptTenantSecrets<T extends Record<string, unknown>>(row: T | null | undefined): T | null {
  if (!row) return null;
  const out: Record<string, unknown> = { ...row };
  for (const key of Object.keys(out)) {
    if (!SECRET_SET.has(key)) continue;
    const v = out[key];
    if (typeof v === "string" && v !== "") out[key] = decryptSecret(v);
  }
  return out as T;
}

export interface SealResult<T> {
  row: T;
}

/**
 * Encrypt every credential field on a patch about to be written.
 *
 * REFUSES rather than storing in the clear (R-051, 7 Oct 2026): with no master
 * key it throws `VaultNotConfiguredError` before returning anything, so a
 * caller cannot write a plaintext credential by accident. Until then it returned
 * the plaintext plus a `storedInClear` list, and every route only console.warn-ed
 * it — a deployment without the key looked healthy while saving keys readable.
 *
 * A patch with no credential to seal (only configuration, or values already
 * encrypted) needs no key and goes through, so changing `gemini_model` alone
 * still works on a keyless server.
 *
 * Already-encrypted values are passed through untouched, so re-saving a form that
 * echoes back a stored value cannot double-wrap it.
 */
export function sealTenantSecrets<T extends Record<string, unknown>>(patch: T): SealResult<T> {
  const out: Record<string, unknown> = { ...patch };
  for (const key of Object.keys(out)) {
    if (!SECRET_SET.has(key)) continue;
    const v = out[key];
    if (typeof v !== "string" || v === "" || isEncrypted(v)) continue;
    out[key] = encryptSecret(v);   // throws VaultNotConfiguredError without a key
  }
  return { row: out as T };
}

/**
 * `sealTenantSecrets` for a route handler: the refusal comes back as a value the
 * route returns as 503 ("server not set up", not the caller's fault) with the
 * next step, instead of an unhandled throw that would surface as a bare 500.
 * Any other error still throws.
 */
export function trySealTenantSecrets<T extends Record<string, unknown>>(
  patch: T,
): { ok: true; row: T } | { ok: false; status: 503; error: string } {
  try {
    return { ok: true, row: sealTenantSecrets(patch).row };
  } catch (e) {
    if (e instanceof VaultNotConfiguredError) return { ok: false, status: 503, error: e.message };
    throw e;
  }
}
