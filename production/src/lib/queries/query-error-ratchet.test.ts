// @vitest-environment jsdom
/**
 * R-1655 (23 Oct 2026) — a failed LIST read must be an error, never an empty list.
 *
 * useQuotes() caught every PostgREST error, logged a warning and returned [] — so when quotes
 * failed to load, /quotes said "No quotes yet", the dashboard's quote figures read ₹0 and
 * Payments' "awaiting invoice" list was silently empty, each with no Try again.
 *
 *  1. useQuotes() with a failing PostgREST client ends in isError (not data: []).
 *  2. Ratchet over src/lib/queries: a queryFn that turns an error into `return []` (a catch
 *     block, or `if (error) return [];`) may only stay where it is written on purpose and
 *     documented. The count may only go down.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/supabase/client", () => {
  const failing = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "order", "eq", "range", "in", "limit"]) chain[m] = () => chain;
    chain.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { message: "permission denied for table quotes", code: "42501" } }).then(ok);
    return chain;
  };
  return { createClient: () => ({ from: failing }) };
});

afterEach(() => cleanup());

describe("useQuotes — a failed read is an error (R-1655)", () => {
  it("ends in isError, not an empty list", async () => {
    const { useQuotes } = await import("./quotes");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useQuotes(), { wrapper });
    await waitFor(() => expect(result.current.isError || result.current.isSuccess).toBe(true));
    expect(result.current.isError).toBe(true);
    expect(result.current.data).toBeUndefined();
  });
});

/** Swallowed list errors that are deliberate: file → how many, and why. */
const ALLOWED: Record<string, number> = {
  /* useRecentDepositTags: only pre-selects the usual "Received in" account; a failed read
     means "no history" and the sheet falls back to "Not sure yet" (documented there). */
  "bank.ts": 1,
};

function swallowCount(src: string): number {
  const ifError = src.match(/if\s*\(\s*\w*[eE]rr(?:or)?\s*\)\s*return\s*\[\s*\]\s*;/g)?.length ?? 0;
  const inCatch = src.match(/catch\s*(?:\([^)]*\))?\s*\{[^{}]*?return\s*\[\s*\]\s*;/g)?.length ?? 0;
  return ifError + inCatch;
}

describe("query modules do not turn a failed list read into [] (R-1655 ratchet)", () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

  it("scanner sees the old useQuotes pattern", () => {
    expect(swallowCount(`try { return await x(); } catch (error) {\n console.warn("e", error);\n return [];\n }`)).toBe(1);
    expect(swallowCount(`if (error) return [];`)).toBe(1);
  });

  it.each(files)("%s", (f) => {
    const n = swallowCount(readFileSync(join(dir, f), "utf8"));
    expect(n, `${f}: a failed read must throw so the page shows an error + Try again (CLAUDE.md §24)`).toBeLessThanOrEqual(ALLOWED[f] ?? 0);
  });
});

/* ── R-1806 (24 Oct 2026) — the same mistake one level up, in the screen ─────────────────
   useQuotesByLead() throws, but the lead drawer read it as `{ data: quotesForLead = [] }` and
   the deal page as `quotesQ.data ?? []` without isError — "No quotes yet", and Delete's
   "never with a quote" check ran on an empty list. Two scans over src/app + src/components:
    A. a money read (quotes / invoices / payments / receivables / dues) destructured with a
       `= []` default. The count may only go down.
    B. every screen that calls useQuotesByLead() looks at its error (isError / LoadError). */
const SRC = join(__dirname, "..", "..");

function walk(d: string, out: string[] = []): string[] {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => p.slice(SRC.length + 1).replace(/\\/g, "/");

const MONEY_HOOK = String.raw`use\w*(?:Quote|Invoice|Payment|Receivable|Outstanding|Due)\w*`;
function defaultedMoneyReads(src: string): number {
  const re = new RegExp(String.raw`\{\s*data:\s*\w+\s*=\s*\[\s*\]\s*\}\s*=\s*` + MONEY_HOOK + String.raw`\(`, "g");
  return src.match(re)?.length ?? 0;
}

/** Deliberate `= []` money reads: file → how many, and why. */
const ALLOWED_DEFAULTED: Record<string, number> = {
  /* Salary payments only mark which bank lines are already booked as salary; booking goes
     through the RPC, which refuses a duplicate. No ₹ total is shown from it. */
  "components/features/banking/salary-lines-dialog.tsx": 1,
};

/** Screens that call useQuotesByLead() without looking at its error, and why.
 *  R-1807: the quote page's reject dialog (its "last open quote — mark the lead Lost?" offer)
 *  now waits for the lead's quotes, so the list is empty. Only ever add with a reason. */
const ALLOWED_BYLEAD_NO_ERROR: Record<string, string> = {};

describe("screens do not read a failed money read as [] (R-1806 ratchet)", () => {
  const files = [...walk(join(SRC, "app")), ...walk(join(SRC, "components"))];

  it("scanner sees the old lead-drawer pattern", () => {
    expect(defaultedMoneyReads("const { data: quotesForLead = [] } = useQuotesByLead(lead?.id);")).toBe(1);
    expect(defaultedMoneyReads("const { data: members = [] } = useTeamMembers();")).toBe(0);
  });

  it("A. no new `{ data: x = [] } = use<Money>()`", () => {
    const over = files
      .map((f) => [rel(f), defaultedMoneyReads(readFileSync(f, "utf8"))] as const)
      .filter(([r, n]) => n > (ALLOWED_DEFAULTED[r] ?? 0));
    expect(over, "a failed money read must show the §24 error + Try again, not an empty list").toEqual([]);
  });

  /* C. Money tiles found by the R-1806 scan that printed ₹0 when THEIR read failed (the page
     only checked its main query). Each must now look at that query's isError. */
  it.each([
    ["app/(app)/marketing/page.tsx", "spend", "Spend this month"],
    ["app/(app)/accounting/cash-flow/page.tsx", "bsQ", "Cash in bank now"],
    ["app/(app)/customers/page.tsx", "moneyFailed", "To collect / Received"],
    /* R-1807 — R-1806's follow-ups. */
    ["app/(app)/marketing/ads/page.tsx", "spend", "Spend / ROAS"],
    ["app/(app)/scorecard/page.tsx", "perf", "everyone's Revenue"],
    ["app/(app)/performance/page.tsx", "perf", "the leaderboard"],
    ["app/(app)/accounting/vendors/page.tsx", "vendorsQ", "Vendors / Outstanding"],
    ["app/(app)/accounting/saas-metrics/page.tsx", "metricsQ", "MRR / ARR"],
    ["components/features/customers/customer-profile.tsx", "moneyFailed", "Outstanding (not 'All clear')"],
    ["components/features/contacts/contact-company-panel.tsx", "moneyFailed", "Outstanding (not 'All clear')"],
  ])("C. %s checks %s before showing %s", (file, name) => {
    const src = readFileSync(join(SRC, file), "utf8");
    expect(src).toMatch(new RegExp(String.raw`\b${name}(\.isError|\b)`));
    expect(src).toMatch(/LoadErrorBanner|LoadError\b|LoadErrorInline/);
    if (name !== "moneyFailed") expect(src).toContain(`${name}.isError`);
  });

  /* D. R-1807: the shared Outstanding tile must be told when its reads failed — both screens
     that render it pass `failed`, so "All clear" is never a guess. */
  it("D. every <CustomerMetricBar> is told whether its reads failed", () => {
    const missing = files
      .filter((f) => /<CustomerMetricBar\b/.test(readFileSync(f, "utf8")))
      .filter((f) => !/<CustomerMetricBar\b[^>]*\bfailed=/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(missing).toEqual([]);
  });

  /* E. R-1807: the lead drawer must tell nextActionFor() and the footer whether its quotes are
     known, or "Send quote" comes back on a failed read. */
  it("E. the lead drawer passes quotesUnknown to nextActionFor and the footer", () => {
    const src = readFileSync(join(SRC, "components/features/leads/lead-detail-sheet.tsx"), "utf8");
    expect(src).toMatch(/nextActionFor\(\{[^}]*quotesUnknown/);
    expect(src).toMatch(/<LeadDetailFooter[\s\S]*?quotesUnknown=/);
  });

  it("B. every screen calling useQuotesByLead() handles its error", () => {
    const missing = files
      .filter((f) => /=\s*useQuotesByLead\(/.test(readFileSync(f, "utf8")))
      .map(rel)
      .filter((r) => !ALLOWED_BYLEAD_NO_ERROR[r])
      .filter((r) => !/isError|LoadError/.test(readFileSync(join(SRC, r), "utf8")));
    expect(missing).toEqual([]);
  });
});
