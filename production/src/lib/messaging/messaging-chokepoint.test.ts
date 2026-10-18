/**
 * R-897 ratchet: lib/messaging is the only door to the email and WhatsApp senders.
 *
 * Like autonomy-chokepoint.test.ts, a source scan — what is checked is WIRING. A new file that
 * imports sendEmail / sendWhatsApp directly could message a customer while "Customer messages"
 * is OFF, so it fails here. A file that mails the company itself (owner alert, invite, password
 * reset) uses sendInternalEmail — and must be on INTERNAL_SENDERS below, with its reason, so
 * every ungated sender is a decision made in review. Stale entries fail too: the list only shrinks.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.|\.testutil\./.test(e.name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(SRC, f).split(sep).join("/");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const FILES = walk(SRC).map((f) => ({ path: rel(f), code: strip(readFileSync(f, "utf8")) }));

const CHOKEPOINT = "lib/messaging/index.ts";

/** Imports `name` (not just a type) from a module whose path matches `mod`. */
function importsName(code: string, name: string, mod: RegExp): boolean {
  const re = /import\s*(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1] || !mod.test(m[3])) continue;
    const names = m[2].split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]);
    if (names.includes(name)) return true;
  }
  return false;
}

/** Files that send to the company's own people — ungated on purpose (see lib/messaging/index.ts). */
const INTERNAL_SENDERS: Record<string, string> = {
  "app/api/academy/apprentices/[id]/login/route.ts": "apprentice's own sign-in details",
  "app/api/cron/ai-reflection/route.ts": "daily ops note to the platform owner",
  "app/api/cron/ai-support-sla/route.ts": "alert to the company that a ticket is unowned",
  "app/api/cron/compliance-reminders/route.ts": "statutory due dates to the company's owner/accountant",
  "app/api/cron/health-digest/route.ts": "error digest to the platform owner",
  "app/api/cron/invoice-dunning/route.ts": "escalation to the company (customer mail goes through sendCustomerEmail)",
  "app/api/cron/provision-hosting/route.ts": "owner alert",
  "app/api/cron/register-domains/route.ts": "owner alert (customer mail goes through sendCustomerEmail)",
  "app/api/cron/renew-domains/route.ts": "owner alert",
  "app/api/cron/renew-hosting/route.ts": "owner alert",
  "app/api/dms/upgrade-request/route.ts": "upgrade request to the platform owner",
  "app/api/integrations/email-provider/test/route.ts": "test mail to the signed-in user",
  "app/api/public/callback/route.ts": "callback request to the owner",
  "app/api/public/checkout/workspace/route.ts": "payment alerts to owner / lead owner (customer mail gated)",
  "app/api/public/enquiry/general/route.ts": "new-enquiry alert to the owner (customer ack gated)",
  "app/api/public/enquiry/workspace/route.ts": "new-lead alert to the owner (customer ack gated)",
  "app/api/public/quote/[id]/accept/route.ts": "quote-accepted alert to the company",
  "app/api/public/quote/[id]/upi-notify/route.ts": "UPI-paid alert to the company",
  "app/api/team/invite/route.ts": "invite to a new team member",
  "app/api/webhooks/razorpay/webhook.server.ts": "payment alerts to owner / lead owner (customer mail gated)",
  "lib/ai/actions/support-dispatcher.ts": "escalation alert to the company (customer reply gated)",
  "lib/auth/email-verification.ts": "sign-up email verification",
  "lib/auth/tenant-match.ts": "join request to the company owner (email + WhatsApp)",
  "lib/collections/overdue-suspension.server.ts": "pause notice to the company (customer notice gated)",
  "lib/inbound/ingest.ts": "new-enquiry alert to the owner",
  "lib/quotes/quote-views.server.ts": "hot-lead alert to the company",
  "server/auth/recovery.ts": "password reset",
};

describe("lib/messaging is the only door", () => {
  it("nothing else imports sendEmail from lib/email/send", () => {
    const offenders = FILES
      .filter((f) => f.path !== CHOKEPOINT && f.path !== "lib/email/send.ts")
      .filter((f) => importsName(f.code, "sendEmail", /(^@\/lib\/email\/send$|^\.\/send$|\/email\/send$)/))
      .map((f) => f.path);
    expect(offenders, "send customer mail with sendCustomerEmail, company mail with sendInternalEmail (lib/messaging)").toEqual([]);
  });

  it("nothing else imports sendWhatsApp from lib/whatsapp/client", () => {
    const offenders = FILES
      .filter((f) => f.path !== CHOKEPOINT && f.path !== "lib/whatsapp/client.ts")
      .filter((f) => importsName(f.code, "sendWhatsApp", /(^@\/lib\/whatsapp\/client$|^\.\/client$|\/whatsapp\/client$)/))
      .map((f) => f.path);
    expect(offenders, "send customer WhatsApp with sendCustomerWhatsApp (lib/messaging)").toEqual([]);
  });

  it("only the email transport talks to Resend, SMTP or the Gmail sender", () => {
    const transport = new Set(["lib/email/send.ts", "lib/email/smtp-transport.ts", "lib/email/gmail-transport.ts"]);
    const offenders = FILES
      .filter((f) => !transport.has(f.path))
      .filter((f) => f.code.includes("api.resend.com") || /\bsendVia(Smtp|Gmail)\s*\(/.test(f.code) || /from\s+["']resend["']/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("only the WhatsApp client posts messages to Meta", () => {
    const offenders = FILES
      .filter((f) => f.path !== "lib/whatsapp/client.ts")
      .filter((f) => /phoneNumberId\)?\}?\/messages/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("every ungated (internal) sender is on the reviewed list", () => {
    const using = FILES
      .filter((f) => f.path !== CHOKEPOINT && /\bsendInternal(Email|WhatsApp)\s*\(/.test(f.code))
      .map((f) => f.path)
      .sort();
    expect(using.filter((p) => !(p in INTERNAL_SENDERS)), "new ungated sender — add it with a reason, or use sendCustomerEmail").toEqual([]);
    expect(Object.keys(INTERNAL_SENDERS).filter((p) => !using.includes(p)), "stale entry — remove it").toEqual([]);
  });

  it("the chokepoint asks the switch BEFORE calling a sender", () => {
    const code = FILES.find((f) => f.path === CHOKEPOINT)!.code;
    const body = code.slice(code.indexOf("export async function sendCustomerMessage"));
    const ask = body.indexOf("await refusal(");
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(body.indexOf("sendEmail(m.email)"));
    expect(body.lastIndexOf("await refusal(")).toBeLessThan(body.indexOf("sendWhatsApp("));
  });
});
