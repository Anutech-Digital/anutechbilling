/**
 * R-726: did the mail really come from the address on its From line?
 *
 * The From line is typed by the sender — anyone can write "ceo@victimco.com" there. Before this,
 * the support bot believed it and read that customer's subscriptions back to whoever sent the
 * mail. Now an email sender is only treated as the customer when a verdict we can TRUST says the
 * From domain passed DKIM (aligned) or DMARC. Anything else → "not proven" → general help only.
 *
 * ─── WHICH VERDICTS ARE TRUSTED ──────────────────────────────────────────────
 * Only ones the sender cannot write:
 *   1. SendGrid Inbound Parse's own `dkim` field ("{@victimco.com : pass}") — SendGrid sets it.
 *   2. `dmarc: "pass"` / `senderVerified: true` in the POST body — set by our own forwarder, whose
 *      request is authenticated by the shared secret (verify-secret.ts) before this runs.
 *   3. An `Authentication-Results` header whose authserv-id is listed in
 *      INBOUND_TRUSTED_AUTHSERV_IDS (comma list, e.g. "mx.google.com"). A sender CAN put a fake
 *      Authentication-Results header into the mail, so no authserv-id is trusted by default.
 * Mailgun's X-Mailgun-Spf / -Dkim-Check-Result are NOT used: they do not say WHICH domain passed,
 * so an attacker's own domain passing would read as "verified".
 *
 * Fail closed: unknown shape, missing domain, parse error → false.
 */

/** The From domain, lower-case, or "" when the address has none. */
function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

/** DMARC-style relaxed alignment: the signing domain is the From domain or a parent of it. */
function aligned(signingDomain: string, fromDomain: string): boolean {
  const d = signingDomain.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  if (!d || !fromDomain || !d.includes(".")) return false;
  return fromDomain === d || fromDomain.endsWith(`.${d}`);
}

/** SendGrid: `dkim` = "{@a.com : pass, @b.com : fail}". */
function sendgridDkimPass(raw: unknown, fromDomain: string): boolean {
  if (typeof raw !== "string") return false;
  for (const m of raw.matchAll(/@?([a-z0-9.-]+)\s*:\s*([a-z]+)/gi)) {
    if (m[2].toLowerCase() === "pass" && aligned(m[1], fromDomain)) return true;
  }
  return false;
}

function trustedAuthservIds(): string[] {
  return (process.env.INBOUND_TRUSTED_AUTHSERV_IDS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** One Authentication-Results value from a trusted authserv-id, proving the From domain. */
function authResultsPass(value: string, fromDomain: string, trusted: string[]): boolean {
  const [servRaw, ...rest] = value.split(";");
  const serv = (servRaw ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!serv || !trusted.includes(serv)) return false;
  for (const clause of rest) {
    const c = clause.trim().toLowerCase();
    const dmarc = /^dmarc=pass\b.*\bheader\.from=([a-z0-9.-]+)/.exec(c);
    if (dmarc && aligned(dmarc[1], fromDomain)) return true;
    const dkim = /^dkim=pass\b.*\bheader\.(?:d|i)=@?([a-z0-9.-]+)/.exec(c);
    if (dkim && aligned(dkim[1], fromDomain)) return true;
  }
  return false;
}

/**
 * True only when a trusted verdict proves `fromEmail`'s domain. `headers` are the lower-cased
 * header map an ingest route already built (may be {}); `body` is the raw provider POST.
 */
export function senderDomainVerified(
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  fromEmail: string,
): boolean {
  try {
    const fromDomain = domainOf(fromEmail);
    if (!fromDomain) return false;

    if (body.senderVerified === true) return true;
    if (typeof body.dmarc === "string" && body.dmarc.trim().toLowerCase() === "pass") return true;

    if (sendgridDkimPass(body.dkim, fromDomain)) return true;

    const trusted = trustedAuthservIds();
    if (trusted.length === 0) return false;
    const ar = headers["authentication-results"];
    const values = Array.isArray(ar) ? ar : typeof ar === "string" ? [ar] : [];
    return values.some((v) => typeof v === "string" && authResultsPass(v, fromDomain, trusted));
  } catch {
    return false;
  }
}

/** Header map from the body shapes support routes see (Postmark array, SendGrid block, object). */
export function headersFromBody(body: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const put = (k: unknown, v: unknown) => {
    if (typeof k !== "string" || typeof v !== "string" || !k.trim()) return;
    const key = k.trim().toLowerCase();
    (out[key] ??= []).push(v.trim());
  };
  let mg = body["message-headers"] ?? body["message_headers"];
  if (typeof mg === "string") { try { mg = JSON.parse(mg); } catch { mg = null; } }
  if (Array.isArray(mg)) for (const pair of mg) if (Array.isArray(pair)) put(pair[0], pair[1]);
  const pm = body["Headers"] ?? body["headers_json"];
  if (Array.isArray(pm)) {
    for (const h of pm) {
      const o = h as { Name?: unknown; Value?: unknown; name?: unknown; value?: unknown };
      put(o.Name ?? o.name, o.Value ?? o.value);
    }
  }
  const sg = body["headers"];
  if (typeof sg === "string") {
    for (const line of sg.split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) put(line.slice(0, i), line.slice(i + 1));
    }
  } else if (sg && typeof sg === "object" && !Array.isArray(sg)) {
    for (const [k, v] of Object.entries(sg as Record<string, unknown>)) put(k, v);
  }
  return out;
}
