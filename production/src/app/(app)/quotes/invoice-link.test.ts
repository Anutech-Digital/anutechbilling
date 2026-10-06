/**
 * A button that names one invoice must open that invoice.
 *
 * ─── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 * The quote detail page rendered `View invoice INV-ADPL-2026-27-0018` and linked to
 * `/invoices` — the whole list, 21 rows, find it yourself. Asked about on 21 Aug 2026:
 * "does this take you to the right place, is it logical?" It did not, and it was not.
 *
 * The exact destination already existed. `/invoices?open=<id>` auto-opens that invoice's
 * dialog, and five other call sites already used it: the Quotes LIST's own Invoiced
 * button, the payments page, the customer panel, the command palette, and the invoices
 * page's copy-link. So this was one screen out of step with the rest of the app, which is
 * precisely why it read as broken rather than unfinished — everything else did it right.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * If a file puts the singular words "View invoice" on screen, that file must also know how
 * to deep-link to one (`/invoices?open=`). The alternative to this rule is remembering,
 * across five files, and the record shows that does not hold.
 *
 * A third site was left pointing at the quote hub on purpose: quote-action-bar.tsx says in
 * a comment that invoiced states "deliberately fall through to the hub, which loads the
 * authoritative payment history". Its LABEL was the lie, not its route, so the label was
 * changed instead — and this test would have caught it either way, which is the point of
 * writing the rule against the words rather than against the href.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, out);
    /* .ts too since S35: the lead drawer's "View invoice" label now lives in
       lib/leads/next-action.ts, a pure module, and a .tsx-only scan would stop seeing it. */
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Comments are not UI, and this scan learned that the hard way: the very comment written
 * to explain this fix contains the words "View invoice", so the first run flagged the file
 * it had just been used to correct. Block comments and whole-line `//` comments come out
 * before matching. Line comments are only stripped when they START a line, so a `https://`
 * inside a string survives.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const files = tsxFiles(SRC).map((file) => ({ file, src: stripComments(readFileSync(file, "utf8")) }));

/* R-218 (after R-086): one invoice has its own page, /invoices/<id>, built by invoiceHref()
   (invoices/invoice-href.ts, which also encodes ids with a "/"). The old `/invoices?open=`
   still works through a redirect for links already out in mails and WhatsApp, but a link
   the app renders today should not take the extra hop. */
const DEEP_LINK = /invoiceHref\(|\/invoices\?open=/;

describe("a control naming one invoice opens that invoice", () => {
  it("has files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('never says "View invoice" without knowing how to deep-link to one', () => {
    const offenders: string[] = [];
    for (const { file, src } of files) {
      /* Singular only. "View invoices" (plural — the subscriptions page listing a
         customer's invoices) is a list destination and correctly goes to the list. */
      if (!/["'>\s]View invoice(?!s)/.test(src)) continue;
      if (!DEEP_LINK.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      "link to invoiceHref(<invoice id>) — the invoice's own page — or label the button for where it actually goes",
    ).toEqual([]);
  });

  it("still finds the two screens this was fixed on, so the rule is not scanning thin air", () => {
    const withDeepLink = files
      .filter(({ src }) => DEEP_LINK.test(src))
      .map(({ file }) => file.replace(/\\/g, "/"));
    expect(withDeepLink.join("\n")).toMatch(/quotes\/\[id\]\/page\.tsx/);
    /* The lead drawer's rule moved out of leads/page.tsx into next-action.ts (S35). */
    expect(withDeepLink.join("\n")).toMatch(/lib\/leads\/next-action\.ts/);
    // And the ones that were already right, which is how the fix was found at all.
    expect(withDeepLink.length).toBeGreaterThanOrEqual(6);
  });
});

describe("R-218: in-app invoice links go straight to /invoices/<id>", () => {
  /* payments/page.tsx joins this list after R-215 (the Payments table card) lands. */
  const FIXED = [
    "app/(app)/quotes/page.tsx",
    "app/(app)/quotes/[id]/page.tsx",
    "components/layout/command-palette.tsx",
    "lib/deals/timeline.ts",
    "lib/leads/next-action.ts",
    "app/(app)/online-orders/invoice-links.ts",
  ];

  it.each(FIXED)("%s has no ?open= invoice link left", (rel) => {
    const src = stripComments(readFileSync(join(SRC, rel), "utf8"));
    expect(src).not.toMatch(/invoices\?open=/);
  });

  it.each(FIXED)("%s builds the address with invoiceHref", (rel) => {
    expect(readFileSync(join(SRC, rel), "utf8")).toMatch(/invoiceHref/);
  });
});
