/**
 * R-535 — /contacts showed a company as its own row with a blank email and phone, next to
 * the real people. Reproduced here with the shapes staging had: a company whose person
 * lives only in customer_contacts (no legacy customers.contact_* columns), and a company
 * with nobody at all (1-Click Onboard / order-made, e.g. "R800 Check Co").
 */
import { describe, it, expect } from "vitest";
import { buildContactBook, isBlankRow, type BookSources } from "./book";
import { contactKind } from "@/lib/queries/contacts";

const T = "2026-10-01T00:00:00Z";
const empty = (): BookSources => ({
  leads: [], customers: [], vendors: [], partners: [], imported: [], employees: [], customerLinks: [],
});
const customer = (o: Partial<BookSources["customers"][number]> & { id: string; name: string }) => ({
  domain: null, contact_name: null, contact_title: null, contact_email: null, contact_phone: null,
  health: null, created_at: T, ...o,
});
const person = (o: Partial<BookSources["imported"][number]> & { id: string }) => ({
  full_name: null, email: null, phone: null, company: null, title: null, source: "manual",
  status: "pending", relationship: null, created_at: T, ...o,
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
    expect(contactKind(row)).toBe("customer");
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
    src.imported = [person({ id: "p1", full_name: "Pooja", email: "pooja@x.in", relationship: "personal" })];

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
    for (const c of book) counts[contactKind(c)] = (counts[contactKind(c)] ?? 0) + 1;
    expect(counts).toEqual({ all: 4, customer: 2, other: 1, vendor: 1 });
    expect(book.filter((c) => contactKind(c) === "customer").every((c) => c.isCompany)).toBe(true);
  });
});
