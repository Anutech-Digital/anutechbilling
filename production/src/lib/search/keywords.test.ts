import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  phoneDigits, customerKeywords, leadKeywords, quoteKeywords,
  invoiceKeywords, subscriptionKeywords, contactKeywords, companyPaletteMeta,
} from "./keywords";

describe("phoneDigits — the lookup that happens when the phone rings", () => {
  it("strips formatting so a typed number matches a stored one", () => {
    expect(phoneDigits("+91 99999 30300")).toContain("919999930300");
    expect(phoneDigits("+91 99999 30300")).toContain("9999930300");
  });

  it("indexes the last ten digits, so +91 and bare forms match each other", () => {
    // Stored with +91, typed without — and the reverse. Both must work.
    const withCode = phoneDigits("+919876543210");
    const without  = phoneDigits("9876543210");
    expect(withCode).toContain("9876543210");
    expect(without).toContain("9876543210");
  });

  it("handles the separators people actually use", () => {
    for (const p of ["98765-43210", "98765 43210", "(98765) 43210", "98765.43210"]) {
      expect(phoneDigits(p)).toContain("9876543210");
    }
  });

  it("ignores anything too short to identify anyone", () => {
    // A three-digit fragment would match most of the table.
    expect(phoneDigits("123")).toEqual([]);
    expect(phoneDigits("")).toEqual([]);
    expect(phoneDigits(null)).toEqual([]);
    expect(phoneDigits("abc")).toEqual([]);
  });

  it("does not duplicate when the number is exactly ten digits", () => {
    expect(phoneDigits("9876543210")).toEqual(["9876543210"]);
  });
});

describe("customerKeywords", () => {
  const c = {
    id: "cus_1", name: "Anutech Digital", contact_name: "Pardeep Sharma",
    contact_email: "pardeep@anutech.in", contact_phone: "+91 99999 30300",
    gstin: "07ABDCA0298H1ZP", domain: "anutech.in",
  };

  // ── The two fields that were missing entirely ────────────────────────────
  it("makes a customer findable by GSTIN", () => {
    expect(customerKeywords(c)).toContain("07abdca0298h1zp");
  });

  it("makes a customer findable by phone number", () => {
    expect(customerKeywords(c)).toContain("9999930300");
  });

  it("still covers name, contact, email and domain", () => {
    const k = customerKeywords(c);
    expect(k).toContain("anutech digital");
    expect(k).toContain("pardeep sharma");
    expect(k).toContain("pardeep@anutech.in");
    expect(k).toContain("anutech.in");
  });

  it("does NOT index the GSTIN state code alone", () => {
    // "27" would match a large share of the table and drown the real answer.
    expect(customerKeywords(c)).not.toContain("07");
  });

  it("skips missing fields without producing empties", () => {
    const k = customerKeywords({ name: "Solo Co" });
    expect(k).toEqual(["solo co"]);
    expect(k.every((t) => t.length > 0)).toBe(true);
  });

  it("de-duplicates when two fields hold the same value", () => {
    const k = customerKeywords({ name: "Same", contact_name: "same", domain: "SAME" });
    expect(k).toEqual(["same"]);
  });
});

describe("leadKeywords — a lead has no customer record to fall back on", () => {
  const l = {
    id: "lead_9", company: "Bright Retail Pvt Ltd", contact_name: "Rohit Mehta",
    email: "rohit@bright.in", phone: "9811122233", domain: "bright.in", plan: "google-workspace-business",
  };

  it("finds a lead by the contact's NAME — previously impossible", () => {
    // The lead row displays company, plan, value and stage. Someone saying
    // "this is Rohit from…" was unfindable.
    expect(leadKeywords(l)).toContain("rohit mehta");
  });

  it("finds a lead by phone — previously impossible", () => {
    expect(leadKeywords(l)).toContain("9811122233");
  });

  it("finds a lead by email and domain", () => {
    const k = leadKeywords(l);
    expect(k).toContain("rohit@bright.in");
    expect(k).toContain("bright.in");
  });
});

describe("quoteKeywords — operators quote the tail, not the whole id", () => {
  const q = { id: "Q-ET-2026-27-0042", customer_name: "Pawan Top Ten", plan: "workspace" };

  it("matches the full id", () => {
    expect(quoteKeywords(q)).toContain("q-et-2026-27-0042");
  });

  it("matches the numeric tail said over the phone", () => {
    // "quote forty-two" / "0042" is how this is actually referenced.
    expect(quoteKeywords(q)).toContain("0042");
  });

  it("matches the customer name", () => {
    expect(quoteKeywords(q)).toContain("pawan top ten");
  });

  it("survives an id with no prefix or no dashes", () => {
    expect(() => quoteKeywords({ id: "12345" })).not.toThrow();
    expect(quoteKeywords({ id: "12345" })).toContain("12345");
  });

  it("handles a missing id", () => {
    expect(quoteKeywords({ customer_name: "X" })).toEqual(["x"]);
  });
});

describe("the remaining categories", () => {
  it("invoices match by id, tail, customer and status", () => {
    const k = invoiceKeywords({ id: "INV-ET-2026-27-0013", customer_name: "Excel Technologies", status: "pending" });
    expect(k).toContain("inv-et-2026-27-0013");
    expect(k).toContain("0013");
    expect(k).toContain("excel technologies");
    expect(k).toContain("pending");
  });

  it("subscriptions match by customer, plan, vendor and status", () => {
    const k = subscriptionKeywords({ customer_name: "SOFTGEN", plan: "Google Workspace Plus", vendor: "Google", status: "active" });
    expect(k).toContain("softgen");
    expect(k).toContain("google workspace plus");
    expect(k).toContain("active");
  });

  it("contacts match by name, email, phone and company", () => {
    const k = contactKeywords({ name: "Vinay", email: "vinay@truhomes.in", phone: "+91 98111 22233", company: "TruHomes" });
    expect(k).toContain("vinay");
    expect(k).toContain("vinay@truhomes.in");
    expect(k).toContain("9811122233");
    expect(k).toContain("truhomes");
  });

  it("every builder tolerates an empty object", () => {
    for (const fn of [customerKeywords, leadKeywords, quoteKeywords, invoiceKeywords, subscriptionKeywords, contactKeywords]) {
      expect(fn({})).toEqual([]);
    }
  });
});

describe("R-821: companyPaletteMeta — the Ctrl+K subtitle under a company", () => {
  const UUID = "17e61b78-9450-4849-ad93-9834d2281647";
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  it("prefers the domain, then city/state, then the contact name", () => {
    expect(companyPaletteMeta({ id: UUID, domain: "excel.in", city: "Pune", contact_name: "Ravi" })).toBe("excel.in");
    expect(companyPaletteMeta({ id: UUID, city: "Pune", state: "Maharashtra", contact_name: "Ravi" })).toBe("Pune, Maharashtra");
    expect(companyPaletteMeta({ id: UUID, state: "Delhi" })).toBe("Delhi");
    expect(companyPaletteMeta({ id: UUID, contact_name: "Ravi Kumar" })).toBe("Ravi Kumar");
  });
  it("is empty — never the id — when nothing readable is set", () => {
    expect(companyPaletteMeta({ id: UUID })).toBe("");
    expect(companyPaletteMeta({ id: UUID, domain: " ", contact_name: UUID })).toBe("");
  });
  it("the palette uses it and no longer falls back to c.id", () => {
    const src = readFileSync(join(__dirname, "../../components/layout/command-palette.tsx"), "utf8");
    expect(src).toContain("companyPaletteMeta(c)");
    expect(src).not.toMatch(/meta=\{meta \|\| c\.id\}/);
    for (const c of [{ id: UUID, name: "Acme" }, { id: UUID, name: "Acme", city: "Pune" }]) {
      expect(companyPaletteMeta(c)).not.toMatch(UUID_RE);
    }
  });
});
