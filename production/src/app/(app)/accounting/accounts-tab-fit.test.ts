/**
 * R-180 (6 Oct 2026) — small Accounts-tab bugs found in an 800px browser test. Source checks,
 * so a later edit that brings one back fails here before anyone opens a browser.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { APP_NAV, flattenNav } from "@/lib/nav";

const SRC = path.join(__dirname, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const navLabel = (href: string) => flattenNav(APP_NAV).find((e) => e.item.href === href)?.item.label;

describe("Accounts tab fits an 800px window (R-180)", () => {
  it("the sidebar names the assets page what the page calls itself", () => {
    expect(read("app/(app)/accounting/assets/page.tsx")).toContain("Assets &amp; EMIs</h1>");
    expect(navLabel("/accounting/assets")).toBe("Assets & EMIs");
  });

  it("the Bank Reconciliation row is short enough not to be cut", () => {
    expect(navLabel("/accounting/banking/brs")).toBe("Bank Reconciliation");
  });

  it("the topbar gives the breadcrumb the free space and never wraps Report Bug", () => {
    const topbar = read("components/layout/topbar.tsx");
    expect(topbar).toMatch(/aria-label="Breadcrumb" className="[^"]*\bflex-1 min-w-0\b/);
    expect(topbar).toMatch(/className="[^"]*\bwhitespace-nowrap\b[^"]*"\s+data-topbar="report-bug"/);
  });

  it("the sidebar menu scrolls up-down only", () => {
    expect(read("components/layout/Sidebar.tsx")).toMatch(/<nav className="[^"]*overflow-y-auto overflow-x-hidden/);
  });

  it("Overview report cards wrap a long name instead of cutting it", () => {
    const src = read("app/(app)/accounting/page.tsx");
    const jump = src.slice(src.indexOf("function JumpCard"));
    expect(jump).not.toMatch(/truncate">\{title\}/);
    expect(jump).toMatch(/break-words">\{title\}/);
  });
});
