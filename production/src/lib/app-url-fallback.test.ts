/**
 * `https://resellersos.web.app` is DEAD, and it is still the fallback in 13 files.
 *
 * Measured 23 Sep 2026: that host answers **503**. L91 measured the same a month
 * earlier and said it plainly — "both paths were broken, and the 'safe default'
 * was as dead as the missing one". L91 fixed the one function it was chasing
 * (`quoteAcceptUrl`, which now returns null so each call site must decide) and
 * the PATTERN survived everywhere else:
 *
 *     const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim()
 *                     || "https://resellersos.web.app";
 *
 * One decision, thirteen copies, and the fix reached one — the shape AGENTS.md
 * L98 keeps recording.
 *
 * WHY THIS IS A SCAN AND NOT A FIX
 *   It is latent, not live: the Dockerfile bakes NEXT_PUBLIC_APP_URL at build
 *   time (`ARG NEXT_PUBLIC_APP_URL="https://reselleros.anutech.in"`, which
 *   answers 200), and L91 records it set on Cloud Run as well. So the fallback
 *   does not fire today. It fires the day someone builds without that arg.
 *
 *   And none of the thirteen route files has a single test. L58 is explicit
 *   about that trade: extracting shared code out of an untested money-adjacent
 *   path is the RISKY option, not the careful one. So the one site with real
 *   customer impact was fixed properly and the rest are pinned here rather than
 *   rewritten in bulk by someone who cannot prove they did it right.
 *
 * WHAT WAS FIXED — TWO SITES, and the second corrects my own first reading
 *   1. `api/public/trial/hosting/confirm` redirected the CUSTOMER — the person
 *      who clicked "confirm your email" — to `${APP_URL}/hosting/trial?…`.
 *   2. `api/webhooks/razorpay` built the GST tax-invoice PDF link with it. I
 *      first recorded the remaining sites as "internal staff links". That was
 *      wrong: this one goes into the CUSTOMER's order confirmation, under the
 *      heading "YOUR GST TAX INVOICE", after they have paid. A statutory
 *      document link to a dead host is worse than the redirect above, and it
 *      was in the list I had just called internal. Check where a string is
 *      CONSUMED, not only where it is declared.
 *
 *   Both now build the base from the request's own origin — no configuration,
 *   cannot be wrong, and it survives this service answering on more than one
 *   hostname (L18). Razorpay calls our public webhook URL, so that request's
 *   origin is a public origin for us. Deleting the razorpay constant made the
 *   compiler report it unused, which is how a dead constant should be found.
 *
 * THE LIST BELOW MAY ONLY SHRINK. A new file using this host fails here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DEAD_HOST = "resellersos.web.app";
const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/**
 * Files that still carry the dead host as a fallback, as of 23 Sep 2026.
 *
 * AUDITED BY RECIPIENT, 23 Sep 2026 — not by eye, because by eye was wrong once.
 *
 * The first pass called these "internal staff links" after reading where the
 * constant was DECLARED. One of them emailed a customer their GST tax invoice,
 * 350 lines below the declaration. So every remaining use was then traced to the
 * `to:` it lands in:
 *
 *   ai-support-sla            `${APP_URL}/support`          -> alert.to (owner)
 *   compliance-reminders      renderReminder(plan, APP_URL) -> users with role
 *                                                              owner / accountant
 *   (provision-hosting — gone 24 Sep 2026: the worker now provisions through the
 *    DMS engine and its owner alerts carry no app link)
 *   trial-expiry              owner alert — REMOVED 6 Oct 2026 (R-065, no trial owner email)
 *   enquiry/general, enquiry/workspace, trial/hosting, trial/workspace,
 *   inbound/ingest            "Open the lead: …"           -> staff
 *   trial/hosting/confirm x3  owner alerts — REMOVED 30 Sep 2026 (no trial owner email)
 *   support-email-inbound, support-whatsapp-inbound
 *                             -> support-dispatcher `${appUrl}/support`
 *                             -> alert.to, in a mail whose body ends
 *                                "Nothing has been sent to the customer."
 *   razorpay                  "Open in app / Open quote"    -> staff
 *
 * All ten (eleven until 24 Sep 2026) are staff-facing, so a dead link there is an annoyance and not a
 * customer seeing a 503. They are left alone deliberately: none of those route
 * files has a test (L58), and the correct shape already exists in this codebase
 * four times over — `(auth)/callback` and `api/auth/signup` pass `origin`,
 * `join-request` and `expense-claim/link` prefer the forwarded host. Convert one
 * when you are next in that file for another reason.
 *
 * Removing an entry is progress; adding one is the bug this file exists to stop.
 */
const KNOWN = [
  "app/api/cron/ai-support-sla/route.ts",
  "app/api/cron/compliance-reminders/route.ts",
  "app/api/public/enquiry/general/route.ts",
  "app/api/public/enquiry/workspace/route.ts",
  "app/api/public/trial/hosting/confirm/route.ts",
  "app/api/v1/integrations/support-email-inbound/route.ts",
  "app/api/v1/integrations/support-whatsapp-inbound/route.ts",
  "app/api/webhooks/razorpay/route.ts",
  "lib/inbound/ingest.ts",
].sort();

/**
 * Comments stripped before an ABSENCE assertion (AGENTS.md L46).
 *
 * This bit me writing this very file: the razorpay route's new comment EXPLAINS
 * that WEBHOOK_APP_URL was deleted, so asserting the raw source does not contain
 * that name failed on the sentence describing its removal. A blunt scan would
 * push the reasoning out of the file to satisfy the test.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe("the dead fallback host does not spread", () => {
  const files = walk(SRC);

  it("the scan actually scanned the tree", () => {
    // Guard the guard: a moved directory would make the assertion below pass
    // by finding nothing at all.
    expect(files.length).toBeGreaterThan(300);
  });

  it("only the known files reference it, and the list may only shrink", () => {
    const found = files
      .filter((f) => readFileSync(f, "utf8").includes(DEAD_HOST))
      .map((f) => relative(SRC, f).split("\\").join("/"))
      .sort();

    const added = found.filter((f) => !KNOWN.includes(f));
    expect(
      added,
      `${DEAD_HOST} answers 503. Do not add it as a fallback — resolve the base URL ` +
        `from the request (new URL(path, req.url)) when you have one, or let the empty ` +
        `case be empty so the caller decides. See L91.`
    ).toEqual([]);

    // Shrinking is the point; a stale entry should be deleted from KNOWN, and
    // saying so here means the list cannot quietly rot into a permanent excuse.
    const goneButListed = KNOWN.filter((f) => !found.includes(f));
    expect(
      goneButListed,
      "these no longer use the dead host — delete them from KNOWN so the list keeps meaning something"
    ).toEqual([]);
  });

  it("the GST invoice link is built from the request, not from the dead fallback", () => {
    /**
     * This link goes to the CUSTOMER after payment. The file still contains the
     * dead host for its internal staff links, so "does the string appear"
     * cannot tell whether this was fixed — pin the behaviour instead.
     */
    const src = readFileSync(join(SRC, "app/api/webhooks/razorpay/route.ts"), "utf8");
    expect(src).toContain("const publicBase = new URL(request.url).origin;");
    expect(src).toContain('pdfDownloadUrl(publicBase, "invoice"');
    // The constant it used to take became unused and was deleted; if it comes
    // back, something is reading env for a customer-facing URL again. Asserted
    // against comment-stripped source, or the comment saying it was removed
    // trips the assertion that it was removed (L46).
    expect(code(src)).not.toContain("WEBHOOK_APP_URL");
  });

  it("the customer-facing redirect no longer depends on it", () => {
    /**
     * The one site that put the dead host in front of a CUSTOMER. Pinned by
     * behaviour rather than by absence: the file still contains the constant
     * for its internal staff alerts, so "does the string appear" cannot tell
     * whether the redirect was fixed.
     */
    const src = readFileSync(
      join(SRC, "app/api/public/trial/hosting/confirm/route.ts"),
      "utf8"
    );
    expect(src).toContain("new URL(`/hosting/trial?confirmed=${status}`, req.url)");
    expect(src).not.toMatch(/redirect\(`\$\{APP_URL\}/);
  });
});
