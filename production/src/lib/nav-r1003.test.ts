import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { allowedRoutesForRole, isRouteAllowed, filterNavForRole, flattenNav, APP_NAV, PAYROLL_ROLES, SALARY_ROLES, type UserRole } from "./nav";

/**
 * R-1003 (11 Oct 2026, P1 launch blocker): payroll is owner / manager / accountant only —
 * Pardeep's R-718 role table. Menu (filterNavForRole) AND route guard (isRouteAllowed, used by
 * middleware) must agree, and the database (salary_payments SELECT) names the same roles.
 */
const PAYROLL_PAGES = [
  "/accounting/payroll",
  "/accounting/salary-register",
  "/accounting/loans",
  "/accounting/employees",
  "/accounting/attendance",
  "/accounting/leave",
  "/accounting/esi-register",
];

const ALLOWED: UserRole[] = ["owner", "manager", "accountant"];
const DENIED: UserRole[] = ["billing", "sales", "sales_senior", "support", "delivery", "partner_agent"];

const menuHrefs = (role: UserRole) => flattenNav(filterNavForRole(APP_NAV, role)).map((e) => e.item.href);

describe("R-1003 payroll roles", () => {
  it("PAYROLL_ROLES is exactly owner, manager, accountant (same as SALARY_ROLES)", () => {
    expect([...PAYROLL_ROLES].sort()).toEqual(["accountant", "manager", "owner"]);
    expect([...PAYROLL_ROLES].sort()).toEqual([...SALARY_ROLES].sort());
  });

  for (const role of ALLOWED) {
    it(`${role} has every payroll page in the menu and the route guard`, () => {
      const menu = menuHrefs(role);
      for (const p of PAYROLL_PAGES) {
        expect(menu, `${role} menu ${p}`).toContain(p);
        expect(isRouteAllowed(role, p), `${role} route ${p}`).toBe(true);
      }
    });
  }

  for (const role of DENIED) {
    it(`${role} has no payroll page in the menu and the route guard refuses a typed URL`, () => {
      const menu = menuHrefs(role);
      const allowed = allowedRoutesForRole(role);
      for (const p of PAYROLL_PAGES) {
        expect(menu, `${role} menu ${p}`).not.toContain(p);
        expect(allowed, `${role} allowed ${p}`).not.toContain(p);
        expect(isRouteAllowed(role, p), `${role} route ${p}`).toBe(false);
        expect(isRouteAllowed(role, p + "/some-id"), `${role} route ${p}/some-id`).toBe(false);
      }
    });
  }

  it("billing keeps its money pages (invoices, banking, accounting overview)", () => {
    for (const p of ["/invoices", "/accounting", "/accounting/banking"]) {
      expect(isRouteAllowed("billing", p), p).toBe(true);
    }
  });

  it("the migration reads salary_payments for owner / manager / accountant only", () => {
    const sql = fs.readFileSync(
      path.join(__dirname, "../../supabase/migrations/20261011142000_r1003_payroll_roles.sql"),
      "utf8",
    );
    const policy = sql.slice(sql.indexOf("create policy salary_payments_select_money_roles"));
    expect(policy).toContain("current_user_has_role('owner', 'manager', 'accountant')");
    expect(policy.slice(0, policy.indexOf(";"))).not.toContain("billing");
    expect(sql).toContain("-- deploy-key: r1003payroll");
  });
});
