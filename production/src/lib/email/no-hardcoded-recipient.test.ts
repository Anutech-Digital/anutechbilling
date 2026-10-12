import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   No server route may hardcode WHO an email goes to.

   Found 22 Aug 2026 by reading api/webhooks/razorpay/route.ts while chasing an
   unrelated log line. Five routes carried a module-level literal:

       const PARDEEP_EMAIL = "Pardeep@example.test";

   and used it as `to:` / `replyTo:`. The razorpay route had already been fixed to
   resolve the tenant's own address, and its header explains the cost:

     "in a multi-tenant product every tenant's payment alert, carrying their
      customer's name, email and amount, was mailed to one fixed address. The
      owner of the tenant that made the sale never got it, and someone else did."

   The other four kept the bug. api/cron/trial-expiry SELECTS `tenant_id` for every
   expired trial, never reads it, and mails all of them — company, contact name,
   contact email, phone, domain — to that single inbox. Three public buy-page
   routes also put it in `replyTo:` on the CUSTOMER's mail, so customers were told
   to reply to a domain the company no longer uses.

   ─── WHY THIS TEST IS BRAND-AGNOSTIC ─────────────────────────────────────────
   The obvious guard is `expect(src).not.toMatch(/democo/)`, which is
   what lib/whatsapp.test.ts does for message signatures. Wrong tool here: tenant
   <client-tenant-id> legitimately HAS that address on file, and a brand-dated guard passes
   happily the day somebody hardcodes `pardeep@anutech.in` instead — the identical
   bug with a fresher domain. So this checks the SHAPE (a literal recipient) and
   not the string, and it will fail on a hardcoded address nobody has thought of
   yet.

   Recipients only — `from:` is deliberately not checked. A From default like
   `onboarding@resend.dev` is a sender identity the provider requires, not a
   decision about whose desk a tenant's customer data lands on.
   ───────────────────────────────────────────────────────────────────────────── */

const API = join(process.cwd(), "src", "app", "api");

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      routeFiles(full, acc);
    } else if (entry.endsWith(".ts") && !entry.includes(".test.")) {
      acc.push(full);
    }
  }
  return acc;
}

/** A bare email literal — no `process.env`, no concatenation, no template hole. */
const EMAIL_LITERAL = /^[^\s@"']+@[^\s@"']+\.[^\s@"']+$/;

/**
 * `const NAME = "someone@example.in";` at module level.
 *
 * Pinned to a pure string literal on purpose: `const FROM = process.env.X || "…"`
 * does not match, because an env-configurable default is a deployment choice, and
 * the thing being caught here is a decision baked into the source.
 */
const CONST_LITERAL = /^\s*const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*["']([^"'\n]+)["']\s*;/gm;

/** `to: X` / `replyTo: X` — an identifier or a literal, in an object being sent. */
const RECIPIENT_FIELD = /\b(?:to|replyTo)\s*:\s*(?:["']([^"'\n]+)["']|([A-Za-z_$][\w$]*))/g;

interface Offence {
  file: string;
  field: string;
  value: string;
}

function scan(file: string): Offence[] {
  const src = readFileSync(file, "utf8");
  const out: Offence[] = [];

  /* Which module-level consts hold a bare address. */
  const literalConsts = new Map<string, string>();
  for (const m of src.matchAll(CONST_LITERAL)) {
    if (EMAIL_LITERAL.test(m[2])) literalConsts.set(m[1], m[2]);
  }

  for (const m of src.matchAll(RECIPIENT_FIELD)) {
    const [, inlineLiteral, identifier] = m;
    if (inlineLiteral && EMAIL_LITERAL.test(inlineLiteral)) {
      out.push({ file, field: m[0].trim(), value: inlineLiteral });
    } else if (identifier && literalConsts.has(identifier)) {
      out.push({ file, field: m[0].trim(), value: literalConsts.get(identifier)! });
    }
  }
  return out;
}

describe("no API route hardcodes an email recipient", () => {
  const files = routeFiles(API);

  it("scanned a realistic number of route files", () => {
    /* Without this the suite passes vacuously the day the folder moves or the walk
       silently returns nothing — the empty-loop trap. */
    expect(files.length).toBeGreaterThan(40);
  });

  it("resolves every `to:` and `replyTo:` from data, never from a literal", () => {
    const offences = files.flatMap(scan);
    const report = offences
      .map((o) => `  ${relative(process.cwd(), o.file)}\n      ${o.field}   → ${o.value}`)
      .join("\n");

    expect(
      offences,
      offences.length
        ? `Hardcoded email recipient(s) found.\n\n${report}\n\n` +
          `Resolve the address from the tenant row instead — lib/email/owner-alert.ts.\n` +
          `A fixed recipient in a multi-tenant product sends one tenant's customer data\n` +
          `to another party's inbox, and the tenant that made the sale never learns.`
        : "",
    ).toEqual([]);
  });

  it("catches a hardcoded recipient whatever the domain", () => {
    /* Proves the guard is about the shape and not about one retired brand: the
       current-brand address is caught identically. Both forms, since the real bug
       appeared as both a named const and an inline literal. */
    const viaConst = `const OWNER = "pardeep@anutech.in";\nsendEmail({ to: OWNER });`;
    const inline   = `sendEmail({ replyTo: "sales@anutech.in" });`;
    for (const [label, source] of [["const", viaConst], ["inline", inline]] as const) {
      const consts = new Map<string, string>();
      for (const m of source.matchAll(CONST_LITERAL)) {
        if (EMAIL_LITERAL.test(m[2])) consts.set(m[1], m[2]);
      }
      const hits = [...source.matchAll(RECIPIENT_FIELD)].filter(
        (m) => (m[1] && EMAIL_LITERAL.test(m[1])) || (m[2] && consts.has(m[2])),
      );
      expect(hits.length, label).toBe(1);
    }
  });

  it("does not flag an env-configurable From default, or a resolved variable", () => {
    /* The false positives that would make this guard get deleted rather than obeyed. */
    const fine = [
      `const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";\nsendEmail({ from: FROM_EMAIL, to: alert.to });`,
      `sendEmail({ to: lead.contact_email, replyTo: owner.to });`,
      `sendEmail({ to: customerEmail, from: "noreply@example.in" });`,
    ];
    for (const source of fine) {
      const consts = new Map<string, string>();
      for (const m of source.matchAll(CONST_LITERAL)) {
        if (EMAIL_LITERAL.test(m[2])) consts.set(m[1], m[2]);
      }
      const hits = [...source.matchAll(RECIPIENT_FIELD)].filter(
        (m) => (m[1] && EMAIL_LITERAL.test(m[1])) || (m[2] && consts.has(m[2])),
      );
      expect(hits, source).toEqual([]);
    }
  });
});
