// R-1414: /attendance/me must never show a blank "Select your profile" dropdown.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canPickEmployee, linkCardMode, noEmployeesReason, NO_EMPLOYEES_MESSAGE, NOT_LINKED_MESSAGE,
  LOGIN_LINK_HREF, LOGIN_LINK_PLACE_LABEL,
} from "./self-profile";

const PAGE = readFileSync(join(process.cwd(), "src/app/(app)/attendance/me/page.tsx"), "utf8");
const CARD = readFileSync(join(process.cwd(), "src/app/(app)/attendance/me/link-employee-card.tsx"), "utf8");

describe("R-1414 linkCardMode", () => {
  it.each(["sales", "support", "delivery", "billing", null, undefined, ""])(
    "low / unknown role %s gets no list, only the ask-owner message",
    (role) => {
      expect(canPickEmployee(role)).toBe(false);
      expect(linkCardMode(role, 5)).toBe("ask-owner");
      expect(linkCardMode(role, 0)).toBe("ask-owner");
    },
  );

  it.each(["owner", "manager", "accountant"])("%s gets the picker list", (role) => {
    expect(canPickEmployee(role)).toBe(true);
    expect(linkCardMode(role, 3)).toBe("pick");
  });

  it.each(["owner", "manager", "accountant"])("%s with nothing to pick gets the empty state", (role) => {
    expect(linkCardMode(role, 0)).toBe("no-employees");
  });

  it("the ask-owner text says what happened, why, and a next step that exists today", () => {
    expect(NOT_LINKED_MESSAGE).toMatch(/isn't linked to an employee profile yet/);
    expect(NOT_LINKED_MESSAGE).toMatch(/report it below/);
    // R-1436: the owner links it on the Employees page now — name that place, never the old dead end.
    expect(NOT_LINKED_MESSAGE).not.toMatch(/isn't in the app yet/);
    expect(NOT_LINKED_MESSAGE).not.toMatch(/Team → Employees/);
    expect(NOT_LINKED_MESSAGE).toMatch(/owner/);
    expect(LOGIN_LINK_PLACE_LABEL).toBe("Employees → Logins for attendance");
    expect(LOGIN_LINK_HREF).toBe("/accounting/employees#logins");
  });

  it("the empty state never claims there are no employees, and gives the link rule", () => {
    expect(NO_EMPLOYEES_MESSAGE).not.toMatch(/No employees yet/);
    expect(noEmployeesReason("a@b.in")).toContain("empty or yours (a@b.in)");
    expect(noEmployeesReason(null)).toMatch(/the one you sign in with/);
  });
});

describe("R-1414 /attendance/me page wiring", () => {
  it("self path reads only self RPCs, never the employees table", () => {
    expect(CARD).not.toMatch(/from\(\s*["']employees["']\s*\)/);
    expect(PAGE).not.toMatch(/from\(\s*["']employees["']\s*\)/);
  });

  it("the link-choices query is only enabled for picker roles", () => {
    expect(PAGE).toContain("<LinkEmployeeCard />");
    expect(CARD).toContain("useMyEmployeeLinkChoices(canPickEmployee(role))");
    expect(CARD).toContain('mode === "ask-owner"');
    expect(CARD).toContain('mode === "no-employees"');
  });

  it("R-1436: once the owner links the login, the not-linked card is gone (only !linked shows it)", () => {
    expect(PAGE).toMatch(/meQ\.data && !meQ\.data\.linked \? \(\s*<LinkEmployeeCard \/>/);
    expect(PAGE.match(/<LinkEmployeeCard \/>/g)?.length).toBe(1);
  });

  it("R-1436: the desktop (no webcam) card does not claim a Google sign-in — logins can be e-mail too", () => {
    expect(PAGE).not.toMatch(/Google Account/);
  });
});
