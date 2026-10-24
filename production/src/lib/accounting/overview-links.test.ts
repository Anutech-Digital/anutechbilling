/**
 * R-1648 — the Accounting Overview showed every role the "Reports & ledgers" cards, including
 * pages the role cannot open (billing: Balance Sheet, Cash Flow; billing/accountant: SaaS
 * Metrics). A click bounced them to their home page with no word. The Overview now shows only
 * what the route guard (nav.ts isRouteAllowed, through canOpenRoute) lets the role open — the
 * same rule, not a second list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_LINKS, reportLinksFor } from "./overview-links";
import { isRouteAllowed, type UserRole } from "@/lib/nav";

const hrefs = (role: string | null | undefined) => reportLinksFor(role).map((l) => l.href);

describe("R-1648: Overview report cards = the pages the role can open", () => {
  it("billing does not see Balance Sheet, Cash Flow or SaaS Metrics", () => {
    const b = hrefs("billing");
    expect(b).not.toContain("/accounting/balance-sheet");
    expect(b).not.toContain("/accounting/cash-flow");
    expect(b).not.toContain("/accounting/saas-metrics");
    expect(b).toContain("/accounting/pnl");
  });

  it("the accountant does not see SaaS Metrics but sees the statements", () => {
    const a = hrefs("accountant");
    expect(a).not.toContain("/accounting/saas-metrics");
    expect(a).toContain("/accounting/balance-sheet");
    expect(a).toContain("/accounting/cash-flow");
  });

  it("the owner and manager see every card", () => {
    expect(hrefs("owner")).toEqual(REPORT_LINKS.map((l) => l.href));
    expect(hrefs("manager")).toEqual(REPORT_LINKS.map((l) => l.href));
  });

  it("one source: shown exactly when the route guard admits the page", () => {
    for (const role of ["manager", "billing", "accountant"] as UserRole[]) {
      for (const l of REPORT_LINKS) {
        expect(hrefs(role).includes(l.href), `${role} ${l.href}`).toBe(isRouteAllowed(role, l.href));
      }
    }
  });

  it("role still loading → nothing hidden (no flicker for the owner)", () => {
    expect(hrefs(undefined)).toEqual(REPORT_LINKS.map((l) => l.href));
  });

  it("the Overview page draws its cards from reportLinksFor, and its other links through canOpenRoute", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/accounting/page.tsx"), "utf8");
    expect(src).toMatch(/reportLinksFor\(/);
    expect(src).not.toMatch(/<JumpCard\s+href="/);       // no hard-coded card a role may not open
    expect(src).toMatch(/canOpenRoute\(/);                // breakdown / alert / folder links
  });
});
