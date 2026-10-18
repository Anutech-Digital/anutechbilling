import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAV, filterNavForRole, flattenNav } from "@/lib/nav";
import { paletteGroupsFor, paletteMayOpen } from "./palette-access";

/* R-1543 (audit 18 Oct 2026): Ctrl+K offered results on pages the role cannot open — sales
   picked a company and bounced to /leads, billing picked a lead and landed on /invoices. */

describe("R-1543: Ctrl+K record groups follow the page rule", () => {
  it("sales: leads and quotes, never companies, invoices, payments or subscriptions", () => {
    const g = paletteGroupsFor("sales");
    expect(g.leads).toBe(true);
    expect(g.quotes).toBe(true);
    expect(g.companies).toBe(false);
    expect(g.invoices).toBe(false);
    expect(g.payments).toBe(false);
    expect(g.subscriptions).toBe(false);
    expect(g.seats).toBe(false);
  });

  it("billing: companies, invoices, payments — never leads or quotes", () => {
    const g = paletteGroupsFor("billing");
    expect(g.companies).toBe(true);
    expect(g.invoices).toBe(true);
    expect(g.payments).toBe(true);
    expect(g.leads).toBe(false);
    expect(g.quotes).toBe(false);
  });

  it("owner sees every group", () => {
    expect(Object.values(paletteGroupsFor("owner")).every(Boolean)).toBe(true);
  });

  it("unknown or loading role: nothing (fails closed, like mayOpenPage)", () => {
    expect(Object.values(paletteGroupsFor(undefined)).some(Boolean)).toBe(false);
    expect(Object.values(paletteGroupsFor("hacker")).some(Boolean)).toBe(false);
  });

  it("billing never gets an owner/manager-only page such as Parent Accounts", () => {
    expect(paletteMayOpen("billing", "/customers/groups")).toBe(false);
    expect(paletteMayOpen("billing", "/customers")).toBe(true);
    expect(paletteMayOpen("owner", "/customers/groups")).toBe(true);
  });

  it("a contact opens only when its record's page is open to the role", () => {
    expect(paletteMayOpen("sales", "/leads?lead=L1")).toBe(true);
    expect(paletteMayOpen("sales", "/customers/C1")).toBe(false);
    expect(paletteMayOpen("billing", "/leads?lead=L1")).toBe(false);
  });

  it("every page the palette lists for a role passes the URL rule (no menu row that bounces)", () => {
    for (const role of ["owner", "manager", "sales", "sales_senior", "billing", "accountant", "support", "delivery", "partner_agent"] as const) {
      for (const { item } of flattenNav(filterNavForRole(APP_NAV, role))) {
        if (item.external) continue;
        expect(paletteMayOpen(role, item.href), `${role} → ${item.href}`).toBe(true);
      }
    }
  });
});

describe("R-1543: command-palette.tsx asks the rule for every list it shows", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "layout", "command-palette.tsx"), "utf8");
  it("record groups, contacts, pages and quick actions are filtered", () => {
    expect(src).toMatch(/paletteGroupsFor\(/);
    expect(src).toMatch(/paletteMayOpen\(role, contactHref\(/);
    expect(src).toMatch(/quickActions[\s\S]*?\.filter\(\(a\) => paletteMayOpen\(role, a\.href\)\)/);
    expect(src).toMatch(/paletteMayOpen\(me\?\.role, item\.href\)/);
  });
});
