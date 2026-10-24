/**
 * One line for a public route to refuse a bot: `const no = await turnstileRefusal(req.headers, body); if (no) return no;`
 *
 * R-020 (2 Oct 2026). The server helper (verifyTurnstile, S20) existed but no route called
 * it, so enquiry and signup could be scripted. With TURNSTILE_SECRET_KEY unset it is a
 * no-op (verifyTurnstile answers ok/skipped), so this ships safely before the keys exist —
 * the order in docs/SECURITY-RUNBOOK.md §2 (widget live first, THEN the secret) still holds.
 */
import { NextResponse } from "next/server";
import { verifyTurnstile, readTurnstileToken } from "@/lib/security/turnstile";
import { clientIp } from "@/lib/security/rate-limit";

export async function turnstileRefusal(headers: Headers, body: unknown): Promise<NextResponse | null> {
  const ts = await verifyTurnstile(readTurnstileToken(headers, body), clientIp(headers));
  if (ts.ok) return null;
  return NextResponse.json(
    /* R-737 (§24): what happened, why, what to do — and a way out if the check keeps failing. */
    { error: "We could not verify this request came from a person — the security check was missing or has expired. Reload the page, let the check finish, and send again. If it keeps failing, WhatsApp or call us and we'll do it for you." },
    { status: 403 },
  );
}

/* ─── R-1549 (19 Oct 2026): a call this server made to itself ─────────────────────────────────
 * The website AI chat files its lead through the enquiry handlers. A chat has no Turnstile
 * widget, so once TURNSTILE_SECRET_KEY is set every chat lead was refused (403, one log line).
 * The chat route builds that request object itself and marks it here; the enquiry handlers skip
 * Turnstile only for a request object in this set. Nothing that arrives over the network can be
 * in it — no header, cookie or body field puts a request here — so a visitor cannot claim it.
 * The chat itself is bounded per visitor (siteVisitorLimit) and only files details the visitor
 * typed (leadDetailsAppearInTranscript). */
const trustedInternal = new WeakSet<Request>();

export function markTrustedInternalCall<R extends Request>(req: R): R {
  trustedInternal.add(req);
  return req;
}

export function isTrustedInternalCall(req: Request): boolean {
  return trustedInternal.has(req);
}

/** turnstileRefusal for a route handler: a request this server marked as its own is let through. */
export async function turnstileRefusalFor(req: Request, body: unknown): Promise<NextResponse | null> {
  if (isTrustedInternalCall(req)) return null;
  return turnstileRefusal(req.headers, body);
}
