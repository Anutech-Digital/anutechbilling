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
    expect(src).toMatch(/onRecordPayment=\{o\.quote_id \? \(\) => setPayQuoteId\(o\.quote_id\)/);
  });

  it("/invoices/<id> has its own Record payment", () => {
    const src = readFileSync(join(SRC, "app/(app)/invoices/invoice-detail.tsx"), "utf8");
    expect(src).toMatch(/<RecordPaymentDialog/);
    expect(src).toMatch(/Record payment/);
  });
});
