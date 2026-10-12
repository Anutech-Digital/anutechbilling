// R-1414: /attendance/me must never show a blank "Select your profile" dropdown.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canPickEmployee, linkCardMode, NOT_LINKED_MESSAGE } from "./self-profile";

const PAGE = readFileSync(join(process.cwd(), "src/app/(app)/attendance/me/page.tsx"), "utf8");

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

  it("the ask-owner text is plain English", () => {
    expect(NOT_LINKED_MESSAGE).toBe(
      "Your login isn't linked to an employee profile yet. Ask the owner to link it in Team → Employees.",
    );
  });
});

describe("R-1414 /attendance/me page wiring", () => {
  it("self path reads only self RPCs, never the employees table", () => {
    expect(PAGE).not.toMatch(/from\(\s*["']employees["']\s*\)/);
  });

  it("the link-choices query is only enabled for picker roles", () => {
    expect(PAGE).toContain("useMyEmployeeLinkChoices(canPickEmployee(role))");
    expect(PAGE).toContain('mode === "ask-owner"');
    expect(PAGE).toContain('mode === "no-employees"');
  });
});
