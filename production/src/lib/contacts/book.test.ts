/**
 * R-535 — /contacts showed a company as its own row with a blank email and phone, next to
 * the real people. Reproduced here with the shapes staging had: a company whose person
 * lives only in customer_contacts (no legacy customers.contact_* columns), and a company
 * with nobody at all (1-Click Onboard / order-made, e.g. "R800 Check Co").
 */
import { describe, it, expect } from "vitest";
import { buildContactBook, isBlankRow, type BookSources } from "./book";


const T = "2026-10-01T00:00:00Z";
const empty = (): BookSources => ({
  leads: [], customers: [], vendors: [], partners: [], imported: [], employees: [], customerLinks: [], relationships: [],
});
const customer = (o: Partial<BookSources["customers"][number]> & { id: string; name: string }) => ({
  domain: null, contact_name: null, contact_title: null, contact_email: null, contact_phone: null,
  health: null, created_at: T, ...o,
});
const person = (o: Partial<BookSources["imported"][number]> & { id: string }) => ({
  full_name: null, email: null, phone: null, company: null, title: null, source: "manual",
  status: "pending", customer_id: null, created_at: T, ...o,
});

describe("company rows on /contacts (R-535)", () => {
  it("a company whose person lives in customer_contacts is one company row with that person's email/phone", () => {
    const src = empty();
    src.customers = [customer({ id: "c1", name: "Acme Corp", domain: "acme.com" })];
    src.imported = [person({ id: "p1", full_name: "Rajesh K", email: "rajesh@acme.com", phone: "+91 98765 43210", company: "Acme Corp" })];
    src.customerLinks = [{ customer_id: "c1", is_primary: true, contacts: { full_name: "Rajesh K", email: "rajesh@acme.com", phone: "+91 98765 43210" } }];

    const book = buildContactBook(src);
    // Before the fix: two rows — "Acme Corp, —, —" and "Rajesh K". Now one.
    expect(book).toHaveLength(1);
    const row = book[0];
    expect(row.isCompany).toBe(true);
    expect(row.name).toBe("Acme Corp");
    expect(row.title).toBe("Rajesh K");          // primary contact under the name
    expect(row.company).toBe("acme.com");         // domain in the Company column
    expect(row.domain).toBe("acme.com");
    expect(row.email).toBe("rajesh@acme.com");
    expect(row.phone).toBe("+91 98765 43210");
    expect(row.business).toBe("customer");
    // Still findable by the company name and the person (page searches title + companies).
    expect(row.companies).toContain("Acme Corp");
  });

  it("the primary link wins over the legacy columns; the legacy columns are the floor", () => {
    const src = empty();
    src.customers = [
      customer({ id: "c1", name: "Beta", contact_name: "Old Person", contact_email: "old@beta.in" }),
      customer({ id: "c2", name: "Gamma", contact_name: "Legacy Only", contact_email: "legacy@gamma.in", contact_phone: "9876500000" }),
    ];
    src.customerLinks = [
      { customer_id: "c1", is_primary: false, contacts: { full_name: "Other", email: "other@beta.in", phone: null } },
      { customer_id: "c1", is_primary: true, contacts: { full_name: "Priya M", email: "priya@beta.in", phone: null } },
    ];
    const book = buildContactBook(src);
    const beta = book.find((c) => c.refId === "c1")!;
    expect(beta.email).toBe("priya@beta.in");
    expect(beta.title).toBe("Priya M");
    const gamma = book.find((c) => c.refId === "c2")!;
    expect(gamma.email).toBe("legacy@gamma.in");
    expect(gamma.phone).toBe("9876500000");
    expect(gamma.title).toBe("Legacy Only");
  });

  it("a company with nobody yet is still listed, clearly as a company, never as a blank person", () => {
    const src = empty();
    src.customers = [customer({ id: "c9", name: "R800 Check Co" })];
    const [row] = buildContactBook(src);
    expect(row.isCompany).toBe(true);
    expect(row.name).toBe("R800 Check Co");
    expect(row.title).toBeNull();
    expect(row.email).toBeNull();
    expect(row.phone).toBeNull();
    expect(isBlankRow(row)).toBe(false);
  });

  it("never emits a row whose name, email and phone are all blank", () => {
    const src = empty();
    src.imported = [
      person({ id: "x1", company: "Only A Company Name" }),            // nothing to reach
      person({ id: "x2", full_name: "  ", email: "", phone: null }),   // whitespace only
      person({ id: "x3", full_name: "Real Person" }),
    ];
    const book = buildContactBook(src);
    expect(book.map((c) => c.refId)).toEqual(["x3"]);
    expect(book.every((c) => !isBlankRow(c))).toBe(true);
  });

  it("people rows are unchanged — leads, vendors, employees, partners, standalone contacts", () => {
    const src = empty();
    src.leads = [{ id: "l1", company: "Lead Co", contact_name: "Lena", contact_email: "lena@lead.co", contact_phone: null, stage: "new", created_at: T }];
    src.vendors = [{ id: "v1", name: "Vend Ltd", contact_name: "Vik", contact_email: "vik@vend.in", contact_phone: null, created_at: T }];
    src.employees = [{ id: "e1", name: "Esha", email: "esha@us.in", phone: null, designation: "Ops", is_active: true, created_at: T }];
    src.partners = [{ id: "r1", name: "Ravi", email: "ravi@ref.in", phone: null, is_active: true, created_at: T }];
    src.imported = [person({ id: "p1", full_name: "Pooja", email: "pooja@x.in" })];

    const by = (id: string) => buildContactBook(src).find((c) => c.refId === id)!;
    expect(by("l1")).toMatchObject({ name: "Lena", company: "Lead Co", email: "lena@lead.co", source: "lead" });
    expect(by("v1")).toMatchObject({ name: "Vik", company: "Vend Ltd", source: "vendor" });
    expect(by("e1")).toMatchObject({ name: "Esha", title: "Ops", source: "employee" });
    expect(by("r1")).toMatchObject({ name: "Ravi", source: "partner" });
    expect(by("p1")).toMatchObject({ name: "Pooja", source: "imported" });
    for (const id of ["l1", "v1", "e1", "r1", "p1"]) expect(by(id).isCompany).toBeUndefined();
  });

  it("non-primary people of a company stay as their own rows (nobody is dropped)", () => {
    const src = empty();
    src.customers = [customer({ id: "c1", name: "Acme", domain: "acme.com" })];
    src.imported = [
      person({ id: "p1", full_name: "Rajesh", email: "rajesh@acme.com" }),
      person({ id: "p2", full_name: "Accounts Desk", email: "accounts@acme.com" }),
    ];
    src.customerLinks = [
      { customer_id: "c1", is_primary: true, contacts: { full_name: "Rajesh", email: "rajesh@acme.com", phone: null } },
      { customer_id: "c1", is_primary: false, contacts: { full_name: "Accounts Desk", email: "accounts@acme.com", phone: null } },
    ];
    const book = buildContactBook(src);
    expect(book).toHaveLength(2);
    expect(book.find((c) => c.isCompany)).toMatchObject({ name: "Acme", title: "Rajesh" });
    expect(book.find((c) => c.refId === "p2")).toMatchObject({ name: "Accounts Desk", source: "imported" });
  });

  it("tab counts still add up: All = every row, Companies = company rows", () => {
    const src = empty();
    src.customers = [
      customer({ id: "c1", name: "Acme", domain: "acme.com" }),
      customer({ id: "c2", name: "Empty Co" }),
    ];
    src.customerLinks = [{ customer_id: "c1", is_primary: true, contacts: { full_name: "Rajesh", email: "rajesh@acme.com", phone: null } }];
    src.imported = [
      person({ id: "p1", full_name: "Rajesh", email: "rajesh@acme.com" }), // merges into Acme
      person({ id: "p2", full_name: "Solo", email: "solo@x.in" }),
      person({ id: "p3" }),                                                 // blank → dropped
    ];
    src.vendors = [{ id: "v1", name: "Vend", contact_name: null, contact_email: null, contact_phone: null, created_at: T }];

    const book = buildContactBook(src);
    const counts: Record<string, number> = { all: book.length };
    for (const c of book) counts[c.business!] = (counts[c.business!] ?? 0) + 1;
    expect(counts).toEqual({ all: 4, customer: 2, none: 1, vendor_partner: 1 });
    expect(book.filter((c) => c.business === "customer").every((c) => c.isCompany)).toBe(true);
  });
});

/* R-1740 — every book row says its Business side (from links, never by hand) and my
   relationship with the person (from that person's contacts row). */
describe("business + relationship on each row (R-1740)", () => {
  const rels = (...r: Array<[string, string, string | null]>) =>
    r.map(([id, relationship_type, closeness]) => ({ id, relationship_type, closeness }));

  it("a lead's person carries the relationship saved on its anchor contact (lead.contact_id)", () => {
    const src = empty();
    src.leads = [{ id: "l1", company: "Rahul Traders", contact_name: "Rahul", contact_email: "rahul@x.in", contact_phone: null, stage: "new", created_at: T, contact_id: "C-RAHUL" }];
    src.relationships = rels(["C-RAHUL", "friend", "close"]);
    const [row] = buildContactBook(src);
    expect(row).toMatchObject({ business: "lead", relationshipType: "friend", closeness: "close", relContactId: "C-RAHUL" });
  });

  it("a new cold lead with no relationship chosen is Unknown", () => {
    const src = empty();
    src.leads = [{ id: "l2", company: "Cold Co", contact_name: "Cold", contact_email: "cold@x.in", contact_phone: null, stage: "new", created_at: T, contact_id: "C-COLD" }];
    src.relationships = rels(["C-COLD", "unknown", null]);
    expect(buildContactBook(src)[0]).toMatchObject({ business: "lead", relationshipType: "unknown", closeness: null });
  });

  it("a company row shows its contact person's relationship and is Business = Customer", () => {
    const src = empty();
    src.customers = [customer({ id: "c1", name: "Acme", domain: "acme.com" })];
    src.customerLinks = [{ customer_id: "c1", contact_id: "C-RAJ", is_primary: true, contacts: { full_name: "Rajesh", email: "rajesh@acme.com", phone: null } }];
    src.relationships = rels(["C-RAJ", "relative", "close"]);
    expect(buildContactBook(src)[0]).toMatchObject({ isCompany: true, business: "customer", relationshipType: "relative", closeness: "close" });
  });

  it("a standalone person linked to a customer is Customer; unlinked is None; vendors/partners are Vendor / Partner", () => {
    const src = empty();
    src.customers = [customer({ id: "c1", name: "Acme" })];
    src.imported = [
      person({ id: "p1", full_name: "Accounts Desk", email: "accounts@acme.com" }),
      person({ id: "p2", full_name: "Pooja", email: "pooja@x.in" }),
      person({ id: "p3", full_name: "Old Link", email: "old@acme.com", customer_id: "c1" }),
    ];
    src.customerLinks = [
      { customer_id: "c1", contact_id: "C-RAJ", is_primary: true, contacts: { full_name: "Rajesh", email: "rajesh@acme.com", phone: null } },
      { customer_id: "c1", contact_id: "p1", is_primary: false, contacts: { full_name: "Accounts Desk", email: "accounts@acme.com", phone: null } },
    ];
    src.vendors = [{ id: "v1", name: "Vend", contact_name: "Vik", contact_email: "vik@vend.in", contact_phone: null, created_at: T }];
    src.partners = [{ id: "r1", name: "Ravi", email: "ravi@ref.in", phone: null, is_active: true, created_at: T }];
    src.relationships = rels(["p2", "acquaintance", "weak"]);
    const book = buildContactBook(src);
    const by = (id: string) => book.find((c) => c.refId === id)!;
    expect(by("p1").business).toBe("customer");
    expect(by("p3").business).toBe("customer");
    expect(by("p2")).toMatchObject({ business: "none", relationshipType: "acquaintance", closeness: "weak" });
    expect(by("v1").business).toBe("vendor_partner");
    expect(by("r1").business).toBe("vendor_partner");
    // No contacts row behind a vendor → Unknown, never blank.
    expect(by("v1").relationshipType).toBe("unknown");
  });

  it("a merged identity is Customer when any of its rows is a customer, and keeps the known relationship", () => {
    const src = empty();
    src.leads = [{ id: "l1", company: "Acme", contact_name: "Rajesh", contact_email: "rajesh@acme.com", contact_phone: null, stage: "won", created_at: "2026-10-05T00:00:00Z", contact_id: "C-L1" }];
    src.imported = [person({ id: "p1", full_name: "Rajesh", email: "rajesh@acme.com", customer_id: "c9" })];
    src.relationships = rels(["C-L1", "unknown", null], ["p1", "friend", "known"]);
    const book = buildContactBook(src);
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ source: "lead", business: "customer", relationshipType: "friend", closeness: "known", relContactId: "p1" });
  });
});
