/**
 * Webhook signature verification — pure, so the security decision is testable
 * without standing up a route.
 *
 * WHY THIS EXISTS. The WhatsApp webhook verified its HMAC only when an app
 * secret happened to be stored:
 *
 *     if (secrets?.whatsapp_app_secret) { ...verify, else 401... }
 *
 * With no secret configured that check was skipped entirely and the payload was
 * processed. Production has no `whatsapp_app_secret` set, so the endpoint was
 * accepting unsigned POSTs: anyone who knew the URL and a tenant id could inject
 * inbound "messages" into that tenant's inbox, which the app turns into contacts,
 * conversations and lead activity.
 *
 * The Razorpay webhook already got this right — no secret means no request can
 * ever be trusted, so it refuses. This brings WhatsApp to the same rule and puts
 * the decision somewhere it can be proved rather than read.
 *
 * FAIL CLOSED IS NOT A PREFERENCE HERE. An unverified webhook is not "less
 * secure", it is unauthenticated remote write access. Refusing costs a
 * configuration step; allowing costs whatever an attacker chooses to send.
 */
import crypto from "node:crypto";

export type SignatureVerdict =
  | { ok: true }
  /** No secret configured — nothing can be verified, so nothing is trusted. */
  | { ok: false; reason: "not_configured" }
  | { ok: false; reason: "missing_header" }
  | { ok: false; reason: "mismatch" };

/** Constant-time compare that tolerates differing lengths without throwing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch. Comparing lengths first leaks
  // only the length, which the attacker already controls, and a differing
  // length is always a mismatch.
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

/**
 * Verify Meta's `x-hub-signature-256` header: `sha256=<hex of HMAC(body)>`.
 *
 * The HMAC covers the RAW body, so callers must pass the exact bytes received —
 * re-serialising parsed JSON changes whitespace and key order and will never match.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string | null | undefined,
): SignatureVerdict {
  const secret = appSecret?.trim();
  if (!secret) return { ok: false, reason: "not_configured" };

  const sig = header?.trim();
  if (!sig) return { ok: false, reason: "missing_header" };

  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(sig, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/**
 * Verify Retell's `x-retell-signature` header — bare hex of HMAC-SHA256(body) under the API
 * key, with no `sha256=` prefix.
 *
 * Same rule as Meta's above, and the same fail-closed posture: no key configured means no
 * request can be verified, so none is trusted. A post-call webhook is not a read — it writes a
 * transcript, sets an outcome, and can trigger a quotation. Accepting an unsigned one would let
 * anybody who knows the URL put words in a customer's mouth and a quote in their inbox.
 */
export function verifyRetellSignature(
  rawBody: string,
  header: string | null | undefined,
  apiKey: string | null | undefined,
): SignatureVerdict {
  const secret = apiKey?.trim();
  if (!secret) return { ok: false, reason: "not_configured" };

  const sig = header?.trim();
  if (!sig) return { ok: false, reason: "missing_header" };

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  /* Compared case-insensitively on the hex only. Retell has shipped both cases at different
     times, and a signature that is byte-identical apart from casing is a correct signature —
     failing it would look exactly like an attack in the logs and send somebody hunting one. */
  return safeEqual(sig.toLowerCase(), expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/**
 * Verify a plain shared-secret header — Vapi's `x-vapi-secret`, which is not an HMAC.
 *
 * Weaker than a signature by construction: it does not bind to the body, so it proves the
 * caller knows the secret and nothing about what they sent. Supported because it is what that
 * provider offers, and constant-time compared so the endpoint does not leak the secret one
 * character at a time.
 */
export function verifySharedSecretHeader(
  header: string | null | undefined,
  secret: string | null | undefined,
): SignatureVerdict {
  const expected = secret?.trim();
  if (!expected) return { ok: false, reason: "not_configured" };

  const given = header?.trim();
  if (!given) return { ok: false, reason: "missing_header" };

  return safeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Operator-facing explanation for a refusal — logged, never returned to the caller. */
export function signatureRefusalReason(reason: Exclude<SignatureVerdict, { ok: true }>["reason"]): string {
  switch (reason) {
    case "not_configured":
      return "no app secret stored for this tenant — every request is refused until one is saved, " +
             "because an unverified webhook is unauthenticated write access, not merely a weaker check";
    case "missing_header":
      /* Every accepted header is named, because the operator reading this line does not know
         which provider the failing request came from — that is precisely what they are trying
         to work out. */
      return "request carried no signature header (x-hub-signature-256 for Meta, " +
             "x-retell-signature for Retell, x-vapi-secret for Vapi, ?bolna_secret= for Bolna)";
    case "mismatch":
      return "signature did not match the body — either the secret is wrong or the payload was altered";
  }
}
