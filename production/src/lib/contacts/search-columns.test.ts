/**
 * R-1821 (24 Oct 2026, security audit) — the browser's search boxes, for a role that sees
 * masked contacts, send nothing the data gateway refuses (maskedQueryRefusal), so Ctrl+K,
 * Customers and Online Orders keep working by name / company for that role — and owner /
 * manager still search phone and email. Each search below is run against the gateway's own
 * check; before the fix the masked-role search still asked contact_phone / email / contact_email
 * (Ctrl+K: palette-search.ts PALETTE_CONTACT_SEARCH; Online Orders: order-query.ts).
 */
import { describe, it, expect } from "vitest";
import { contactSearchHidden, searchableColumns } from "./search-columns";
import { maskedQueryRefusal } from "@/server/postgrest/contact-mask";
import { searchPaletteContacts, searchPaletteCustomers } from "@/lib/queries/palette-search";
import { customerSearchOr } from "@/lib/queries/customers";
import { orderSearchOr } from "@/app/(app)/online-orders/order-query";

/** A query-builder double that records the or= filters. */
function fakeDb() {
  const ors: string[] = [];
  const b = {
    select() { return b; }, eq() { return b; }, neq() { return b; }, order() { return b; },
    or(f: string) { ors.push(f); return b; },
    limit() { return Promise.resolve({ data: [], error: null }); },
  };
  return { db: { from: () => b } as never, ors };
}

/** What the gateway says to this or= group on `table` (null = allowed). */
const gateway = (table: string, or: string) => maskedQueryRefusal(table, new URLSearchParams({ select: "id", or: `(${or})` }), null);

describe("who searches without phone / email", () => {
  it("owner and manager keep the full search; sales, accountant, partner agent and a loading role do not", () => {
    expect(contactSearchHidden("owner")).toBe(false);
    expect(contactSearchHidden("manager")).toBe(false);
    for (const r of ["sales", "accountant", "partner_agent", null, undefined]) expect(contactSearchHidden(r)).toBe(true);
  });

  it("searchableColumns drops only the phone / email / mobile / whatsapp columns", () => {
    expect(searchableColumns(["name", "contact_email", "phone", "contact_mobile", "whatsapp", "gstin"], true)).toEqual(["name", "gstin"]);
    expect(searchableColumns(["name", "contact_email"], false)).toEqual(["name", "contact_email"]);
  });
});

describe("R-1821: Ctrl+K (palette) for a masked role", () => {
  it("probe: Companies and Contacts search is accepted by the gateway, and finds by name", async () => {
    for (const [table, run] of [
      ["customers", (db: never) => searchPaletteCustomers(db, "98765 acme", "t1", true)],
      ["contacts", (db: never) => searchPaletteContacts(db, "98765", "t1", true)],
    ] as const) {
      const { db, ors } = fakeDb();
      await run(db);
      expect(ors.length).toBeGreaterThan(0);
      for (const or of ors) {
        expect(gateway(table, or), `${table}: ${or}`).toBeNull();
        expect(or).not.toMatch(/phone|email/);
      }
    }
  });

  it("owner: phone and email are still searched", async () => {
    const { db, ors } = fakeDb();
    await searchPaletteContacts(db, "98765", "t1", false);
    expect(ors[0]).toContain('phone.ilike."%98765%"');
    expect(ors[0]).toContain('email.ilike."%98765%"');
  });
});

describe("R-1821: Customers list search for a masked role", () => {
  it("probe: the or= group passes the gateway; owner's still holds contact_phone", () => {
    expect(gateway("customers", customerSearchOr("98765", null, true)!)).toBeNull();
    expect(customerSearchOr("98765", null, false)).toContain("contact_phone.ilike");
  });
});

describe("R-1821: Online Orders search for a masked role", () => {
  it("probe: the search does not ask contact_email; owner's does", () => {
    expect(gateway("leads", orderSearchOr("ravi@", true)!)).toBeNull();
    expect(orderSearchOr("ravi@", true)).toContain('company.ilike."%ravi@%"');
    expect(orderSearchOr("ravi@", false)).toContain("contact_email.ilike");
  });
});
