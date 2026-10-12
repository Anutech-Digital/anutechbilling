import { describe, it, expect } from "vitest";
import {
  isOwnAdvance,
  seesAllAdvances,
  nameTokens,
  firstNameToken,
  visibleAdvances,
} from "./advance-visibility";

/* ─────────────────────────────────────────────────────────────────────────────
   Everything here uses the REAL staff list of the ANUTECH tenant and the one
   real advance, read from the live database on 22 Aug 2026. Invented names would
   not have caught the Ranjeet/Raj collision, which is the whole point of the file.

   Users (10) — the five that reach the name filter are marked ►
       deepak@anutech.in              Deepak Sharma          owner
       info@omegaco.test  Omega Co  owner
       pardeep@anutech.in             Pardeep Sharma         owner
       ananya@anutech.in              Ananya Sharma          manager
       hitesh@anutech.in              Hitesh Baghel          manager
     ► sales@anutech.in               Darshan (Sales)        sales_senior
     ► pratik@anutech.in              Pratik Sharma          support
     ► ranjeet@anutech.in             Ranjeet Raj            support
     ► abhishek@anutech.in            Abhishek Sharma        delivery
     ► pawan@anutech.in               Pawan Kumar            delivery

   Advances: exactly one row, tenant ANUTECH, vendor_name 'Darshan', Rs 2,000.
   ───────────────────────────────────────────────────────────────────────────── */

const STAFF = [
  { email: "sales@anutech.in",    fullName: "Darshan (Sales)", role: "sales_senior" },
  { email: "pratik@anutech.in",   fullName: "Pratik Sharma",   role: "support" },
  { email: "ranjeet@anutech.in",  fullName: "Ranjeet Raj",     role: "support" },
  { email: "abhishek@anutech.in", fullName: "Abhishek Sharma", role: "delivery" },
  { email: "pawan@anutech.in",    fullName: "Pawan Kumar",     role: "delivery" },
] as const;

const THE_REAL_ADVANCE = { id: "a1", vendor_name: "Darshan", amount: 2000 };

describe("nameTokens / firstNameToken", () => {
  it("treats punctuation as a separator, so a parenthesised label is not part of the name", () => {
    expect(nameTokens("Darshan (Sales)")).toEqual(["darshan", "sales"]);
    expect(firstNameToken("Darshan (Sales)")).toBe("darshan");
  });

  it("returns nothing usable for a blank or punctuation-only name", () => {
    for (const v of [null, undefined, "", "   ", "()", "--"]) {
      expect(firstNameToken(v), JSON.stringify(v)).toBeNull();
    }
  });
});

describe("seesAllAdvances", () => {
  it("lets owner, manager and accountant see the whole tenant's advances", () => {
    for (const r of ["owner", "manager", "accountant", "Owner", " MANAGER "]) {
      expect(seesAllAdvances(r), r).toBe(true);
    }
  });

  it("does not let an individual contributor role see everything", () => {
    for (const r of ["sales", "sales_senior", "support", "delivery", "", null, undefined]) {
      expect(seesAllAdvances(r), String(r)).toBe(false);
    }
  });
});

describe("isOwnAdvance — the real staff list against the real advance", () => {
  it("shows Darshan's Rs 2,000 advance to Darshan, whose profile name carries a suffix", () => {
    expect(isOwnAdvance("Darshan (Sales)", "Darshan")).toBe(true);
  });

  it("shows it to NOBODY else on the staff list", () => {
    for (const s of STAFF.filter((s) => s.email !== "sales@anutech.in")) {
      expect(isOwnAdvance(s.fullName, "Darshan"), s.email).toBe(false);
    }
  });
});

describe("isOwnAdvance — the collisions the old substring rule let through", () => {
  it("does NOT show an advance named 'Raj' to Ranjeet Raj", () => {
    /* The old rule was `curName.includes(empName)`, and "ranjeet raj" contains
       "raj". A surname is shared; it cannot decide whose money this is. */
    expect(isOwnAdvance("Ranjeet Raj", "Raj")).toBe(false);
  });

  it("does NOT show an advance named 'Sharma' to any of the five Sharmas", () => {
    for (const n of ["Pratik Sharma", "Abhishek Sharma", "Ananya Sharma", "Deepak Sharma", "Pardeep Sharma"]) {
      expect(isOwnAdvance(n, "Sharma"), n).toBe(false);
    }
  });

  it("does NOT show an advance named 'Sales' to Darshan (Sales)", () => {
    /* "sales" is a token of the viewer's name but not its first — a label, not
       a person. The old rule matched it both ways round. */
    expect(isOwnAdvance("Darshan (Sales)", "Sales")).toBe(false);
  });

  it("ignores email entirely — the deleted ladder keyed off it", () => {
    /* There is no email parameter, and that is the assertion: the old clause gave
       anyone whose address contained "sales" every advance named "darshan". A
       hardcoded grant cannot be expressed here at all now. */
    expect(isOwnAdvance("Pratik Sharma", "Darshan")).toBe(false);
    expect(isOwnAdvance("Omega Co", "Darshan")).toBe(false);
  });
});

describe("isOwnAdvance — fails closed", () => {
  it("matches nothing when the advance has no name on it", () => {
    for (const v of [null, undefined, ""]) {
      expect(isOwnAdvance("Darshan (Sales)", v), String(v)).toBe(false);
    }
  });

  it("matches nothing when the viewer has no name on their profile", () => {
    for (const v of [null, undefined, ""]) {
      expect(isOwnAdvance(v, "Darshan"), String(v)).toBe(false);
    }
  });

  it("does not hand an unnamed advance to somebody called 'Employee'", () => {
    /* The UI falls back to the label "Employee" when vendor_name is null. That
       fallback must never reach the matcher — a placeholder standing in for a
       missing value is exactly the AGENTS.md §2 mistake. */
    expect(isOwnAdvance("Employee", null)).toBe(false);
    expect(isOwnAdvance("Employee Name", "")).toBe(false);
  });

  it("does not match on an empty token pair produced by punctuation", () => {
    expect(isOwnAdvance("()", "--")).toBe(false);
  });

  it("still matches when only the first names agree and the rest differs", () => {
    expect(isOwnAdvance("Pawan Kumar", "Pawan")).toBe(true);
    expect(isOwnAdvance("Pawan Kumar", "Pawan Kumar")).toBe(true);
  });
});

describe("visibleAdvances", () => {
  const rows = [
    THE_REAL_ADVANCE,
    { id: "a2", vendor_name: "Pawan", amount: 500 },
    { id: "a3", vendor_name: null, amount: 100 },
  ];
  const nameOf = (r: (typeof rows)[number]) => r.vendor_name;

  it("gives an owner every advance, including the unnamed one", () => {
    const seen = visibleAdvances(rows, nameOf, { role: "owner", fullName: "Pardeep Sharma" });
    expect(seen.map((r) => r.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("gives each individual exactly their own row", () => {
    expect(visibleAdvances(rows, nameOf, { role: "sales_senior", fullName: "Darshan (Sales)" }).map((r) => r.id))
      .toEqual(["a1"]);
    expect(visibleAdvances(rows, nameOf, { role: "delivery", fullName: "Pawan Kumar" }).map((r) => r.id))
      .toEqual(["a2"]);
  });

  it("gives an individual with no matching advance an empty list, not everything", () => {
    /* The failure mode worth guarding: a filter that matches nothing and then
       falls back to the unfiltered set. Ranjeet has no advance; Ranjeet sees none
       — not the three that exist. */
    expect(visibleAdvances(rows, nameOf, { role: "support", fullName: "Ranjeet Raj" })).toEqual([]);
  });

  it("never leaks the unnamed advance to an individual", () => {
    for (const s of STAFF) {
      const seen = visibleAdvances(rows, nameOf, { role: s.role, fullName: s.fullName });
      expect(seen.some((r) => r.id === "a3"), s.email).toBe(false);
    }
  });

  it("does not hand back the caller's own array, so a caller cannot mutate the source", () => {
    const all = visibleAdvances(rows, nameOf, { role: "owner", fullName: "X" });
    expect(all).not.toBe(rows);
  });
});
