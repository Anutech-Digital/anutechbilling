// R-1436: the owner links an employee profile to a teammate's login on the Employees page.
import { describe, it, expect } from "vitest";
import {
  canLinkLogins,
  linkedLoginFor,
  loginChoicesFor,
  loginLabel,
  planLoginLink,
  type TenantLogin,
} from "./login-link";

const login = (over: Partial<TenantLogin> & { id: string }): TenantLogin => ({
  full_name: null, email: null, role: "sales", employee_id: null, is_active: true, ...over,
});

const LOGINS: TenantLogin[] = [
  login({ id: "u-owner", full_name: "Owner", role: "owner", employee_id: "e-owner" }),
  login({ id: "u-sales", full_name: "Pawan Sales", email: "pawan.sales@acme.in" }),
  login({ id: "u-support", full_name: null, email: "help@acme.in", role: "support", employee_id: "e-asha" }),
  login({ id: "u-gone", full_name: "Left", is_active: false }),
];

describe("R-1436 canLinkLogins", () => {
  it("only the owner — the DB guard (R-712) lets only an active owner change another login's employee link", () => {
    expect(canLinkLogins("owner")).toBe(true);
    for (const r of ["manager", "accountant", "sales", "support", "delivery", "billing", null, undefined, ""]) {
      expect(canLinkLogins(r)).toBe(false);
    }
  });
});

describe("R-1436 choices", () => {
  it("finds the login already linked to an employee", () => {
    expect(linkedLoginFor("e-asha", LOGINS)?.id).toBe("u-support");
    expect(linkedLoginFor("e-new", LOGINS)).toBeNull();
  });

  it("offers active logins that are free, plus the one already linked to THIS employee", () => {
    expect(loginChoicesFor("e-new", LOGINS).map((l) => l.id)).toEqual(["u-sales"]);
    expect(loginChoicesFor("e-asha", LOGINS).map((l) => l.id).sort()).toEqual(["u-sales", "u-support"]);
  });

  it("never offers an inactive login or one linked to another employee", () => {
    const ids = loginChoicesFor("e-new", LOGINS).map((l) => l.id);
    expect(ids).not.toContain("u-gone");
    expect(ids).not.toContain("u-owner");
    expect(ids).not.toContain("u-support");
  });

  it("labels a login by name, else e-mail, with the role", () => {
    expect(loginLabel(LOGINS[1])).toBe("Pawan Sales · sales");
    expect(loginLabel(LOGINS[2])).toBe("help@acme.in · support");
  });
});

describe("R-1436 planLoginLink", () => {
  it("link a free login to an unlinked employee: one write", () => {
    expect(planLoginLink("e-new", "u-sales", LOGINS)).toEqual([{ userId: "u-sales", employeeId: "e-new" }]);
  });

  it("switching to another login unlinks the old one FIRST (the guard refuses two logins on one employee)", () => {
    expect(planLoginLink("e-asha", "u-sales", LOGINS)).toEqual([
      { userId: "u-support", employeeId: null },
      { userId: "u-sales", employeeId: "e-asha" },
    ]);
  });

  it("unlink: clears the linked login only", () => {
    expect(planLoginLink("e-asha", null, LOGINS)).toEqual([{ userId: "u-support", employeeId: null }]);
    expect(planLoginLink("e-new", null, LOGINS)).toEqual([]);
  });

  it("picking the login that is already linked does nothing", () => {
    expect(planLoginLink("e-asha", "u-support", LOGINS)).toEqual([]);
  });
});
