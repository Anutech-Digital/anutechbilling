/**
 * Capability tokens for public PDF links (/api/v1/documents/{type}/{id}/pdf).
 *
 * DSP embeds these URLs in its UI, so the browser opens them WITHOUT a Bearer
 * header. Instead of a login, each URL carries an unguessable HMAC token bound
 * to (type, id, tenant). The route fetches the doc by id → reads its tenant →
 * recomputes the token → constant-time compares. No token / wrong token → 403.
 *
 * ─── S20 (28 Sep 2026): token ab EXPIRE hota hai ─────────────────────────────
 * Pehle token = hmac(type:id:tenant) — kabhi expire nahi hota tha. Ek baar leak hua link
 * (forward kiya email, browser history, screenshot) hamesha ke liye GST invoice kholta.
 *
 * Naya format: `<exp>.<hmac(v2:type:id:tenant:exp)>` — exp unix seconds me, HMAC ke ANDAR,
 * isliye badla nahi ja sakta. Default umar PDF_TOKEN_TTL_DAYS (30 din).
 *
 * Purane (bina exp wale, 64-hex) token grace window tak chalte hain — `SIGNING_LEGACY_UNTIL`,
 * default 31 Dec 2026 (lib/security/signing-secrets.ts). Kyun chalne chahiye: DSP ki list
 * API har baar naya link banati hai, to wahan purane link apne aap badal jaate hain — par
 * order-confirmation email me gaya link wapas nahi aata. Grace ke baad wo 403.
 *
 * Chaabi: PDF_SIGNING_SECRET, na ho to service-role key. PDF_SIGNING_SECRET set karne ke
 * baad bhi service-role se sign hue token grace tak verify hote hain — secret kisi bhi din
 * set karo, koi link nahi tootega.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { signingSecrets, legacyGraceActive } from "@/lib/security/signing-secrets";

/** R-1526: "statement" = a customer's pending-dues statement (id = customer id). */
export type PdfDocType = "invoice" | "quote" | "statement";

export const DEFAULT_PDF_TTL_DAYS = 30;
/* Upar ki seema: ek "hamesha" wala link galti se na ban jaye (ttl=99999). */
const MAX_TTL_DAYS = 400;

const V2_RE = /^(\d{9,11})\.([0-9a-f]{64})$/;
const LEGACY_RE = /^[0-9a-f]{64}$/;

function ttlDays(explicit?: number): number {
  const fromEnv = Number(process.env.PDF_TOKEN_TTL_DAYS);
  const raw = explicit ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PDF_TTL_DAYS);
  return Math.min(MAX_TTL_DAYS, Math.max(1, Math.floor(raw)));
}

function hmacHex(secret: string, msg: string): string {
  return createHmac("sha256", secret).update(msg).digest("hex");
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface PdfTokenOpts {
  /** Kitne din chale. Default PDF_TOKEN_TTL_DAYS ya 30; 1..400 me clamp. */
  ttlDays?: number;
  /** Test ke liye — ghadi. */
  now?: Date;
}

export function signPdfToken(type: PdfDocType, id: string, tenantId: string, opts: PdfTokenOpts = {}): string {
  const now = opts.now ?? new Date();
  const exp = Math.floor(now.getTime() / 1000) + ttlDays(opts.ttlDays) * 86_400;
  const { primary } = signingSecrets(now);
  return `${exp}.${hmacHex(primary, `v2:${type}:${id}:${tenantId}:${exp}`)}`;
}

export function verifyPdfToken(
  type: PdfDocType,
  id: string,
  tenantId: string,
  token: string,
  now: Date = new Date(),
): boolean {
  if (!token) return false;
  const { primary, legacy } = signingSecrets(now);
  const secrets = [primary, ...legacy];

  const v2 = V2_RE.exec(token);
  if (v2) {
    const exp = Number(v2[1]);
    /* exp HMAC ke andar hai — yahan ki jaanch sirf "abhi zinda hai ya nahi". */
    if (exp * 1000 <= now.getTime()) return false;
    const msg = `v2:${type}:${id}:${tenantId}:${exp}`;
    return secrets.some((s) => safeEq(hmacHex(s, msg), v2[2]));
  }

  /* Purana format: sirf grace window tak. */
  if (LEGACY_RE.test(token) && legacyGraceActive(now)) {
    const msg = `${type}:${id}:${tenantId}`;
    return secrets.some((s) => safeEq(hmacHex(s, msg), token));
  }
  return false;
}

/** Full downloadable URL for a document PDF (what we put in `pdf_url`). */
export function pdfDownloadUrl(
  appUrl: string,
  type: PdfDocType,
  id: string,
  tenantId: string,
  opts: PdfTokenOpts = {},
): string {
  const base = appUrl.replace(/\/$/, "");
  return `${base}/api/v1/documents/${type}/${encodeURIComponent(id)}/pdf?token=${signPdfToken(type, id, tenantId, opts)}`;
}
