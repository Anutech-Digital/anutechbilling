import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canOpenQuotes } from "./access";
import { isRouteAllowed } from "@/lib/nav";

describe("R-237 canOpenQuotes follows the route guard", () => {
  it("owner, manager, sales can open quotes", () => {
    for (const r of ["owner", "manager", "sales", "sales_senior"]) expect(canOpenQuotes(r)).toBe(true);
  });
  it("billing, support, accountant cannot (middleware sends them home)", () => {
    for (const r of ["billing", "support", "accountant"]) {
      expect(canOpenQuotes(r)).toBe(false);
      expect(isRouteAllowed(r as never, "/quotes/Q-1")).toBe(false);
    }
  });
  it("unknown role (still loading) shows no quote link", () => {
    expect(canOpenQuotes(null)).toBe(false);
    expect(canOpenQuotes(undefined)).toBe(false);
  });
});

/* Every quote link on the screens billing uses must sit behind canQuotes (or a helper
   built on it). A bare `/quotes/...` link is exactly what bounced billing to /invoices. */
const SRC = join(process.cwd(), "src");
const FILES = [
  "app/(app)/payments/page.tsx",
  "app/(app)/invoices/page.tsx",
  "app/(app)/invoices/invoice-detail.tsx",
  "app/(app)/renewals/page.tsx",
  "components/features/customers/customer-profile.tsx",
];
const GUARD = /canQuotes|canOpenQuotes|openQuote|MaybeQuoteLink/;

describe("R-237 no unguarded quote link on billing screens", () => {
  for (const f of FILES) {
    it(f, () => {
      const lines = readFileSync(join(SRC, f), "utf8").split(/\r?\n/);
      const bare: string[] = [];
      lines.forEach((line, i) => {
        if (!/["'`]\/quotes(\/|["'`?])/.test(line)) return;
        if (/^\s*(\/\/|\/?\*)/.test(line)) return; // comments
        const ctx = lines.slice(Math.max(0, i - 12), i + 1).join("\n");
        if (!GUARD.test(ctx)) bare.push(`${i + 1}: ${line.trim()}`);
      });
      expect(bare).toEqual([]);
    });
  }

  it("Payments outstanding Record payment / Pay open the dialog, not a quote link", () => {
    const src = readFileSync(join(SRC, "app/(app)/payments/page.tsx"), "utf8");
    expect(src).not.toMatch(/recordPaymentHref/);
    expect(src).toMatch(/<RecordQuotePaymentDialog/);
    // R-1697/R-1698: every dues row's Record payment goes through DuesPayButton, which hands the
    // chosen quote to the same in-page dialog (setPayQuoteId) — never a link to /quotes/<id>.
    // R-1698 moved the rows into dues-list.tsx: the page now builds ONE payButton for both
    // layouts, so the guard checks the page wiring and the list together.
    expect(src.match(/<DuesPayButton\b/g)?.length).toBe(1);
    expect(src).toMatch(/payButton: \(o\) => <DuesPayButton route=\{duesPaymentRoute\(o, [^\n]*? onRecord=\{setPayQuoteId\} \/>/);
    // Role gate: a view-only role (canWriteSales false) gets the list with no pay button.
    expect(src).toMatch(/<SubscriptionDuesList\s+rows=\{outstanding\}\s+readOnly=\{!canWrite\}/);
    expect(src).toMatch(/const canWrite = canWriteSales\(me\?\.role\)/);

    const list = readFileSync(join(SRC, "app/(app)/payments/dues-list.tsx"), "utf8");
    // Both layouts (cards below 1280px, table from 1280px) render the page's payButton…
    const uses = [...list.matchAll(/\{actions\.payButton\(o\)\}/g)];
    expect(uses.length).toBe(2);
    // …and each one sits behind the readOnly gate (cards: `!readOnly && (`, table: `readOnly ? … : (`).
    for (const u of uses) {
      const before = list.slice(Math.max(0, (u.index ?? 0) - 300), u.index);
      expect(before).toMatch(/(\{!readOnly && \(|\{readOnly \? [^\n]*: \()[^{}]*<div[^>]*>\s*$/);
    }
    // No second, ungated pay path in the list: no own Record-payment button, no quote link.
    expect(list).not.toMatch(/\/quotes\//);
    expect(list).not.toMatch(/>\s*Record payment\s*<|onRecordPayment=|<DuesPayButton\b|<RecordQuotePaymentDialog\b|icon="(wallet|rupee)"/);
    const btn = readFileSync(join(SRC, "app/(app)/payments/dues-pay.tsx"), "utf8");
    expect(btn).toMatch(/onClick=\{route\.kind === "quote" \? \(\) => onRecord\(route\.quoteId\)/);
    expect(btn).not.toMatch(/\/quotes\//);
  });

  it("/invoices/<id> has its own Record payment", () => {
    const src = readFileSync(join(SRC, "app/(app)/invoices/invoice-detail.tsx"), "utf8");
    expect(src).toMatch(/<RecordPaymentDialog/);
    expect(src).toMatch(/Record payment/);
  });
});
