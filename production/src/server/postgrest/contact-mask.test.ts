/**
 * R-1009: the data gateway masks a lead's / customer's / contact's phone and email for a role
 * without can_view_contact_details — so the browser never receives the real value — and never
 * writes a masked value back over the real one.
 */
import { describe, it, expect } from "vitest";
import { USER_ROLES, can } from "@/lib/auth/roles";
import {
  CONTACT_COLUMNS, isMaskedContact, maskContactsInBody, mustMaskContacts, stripMaskedContactWrites, touchesContactTables,
} from "./contact-mask";

const q = (select: string | null) => {
  const s = new URLSearchParams();
  if (select !== null) s.set("select", select);
  return s;
};

const LEAD = { id: "l1", name: "Ravi", contact_phone: "+91 98765 43210", contact_email: "ravi@shop.in", notes: "call ravi@shop.in" };

describe("who is masked", () => {
  it("owner and manager are NEVER masked", () => {
    expect(mustMaskContacts("owner")).toBe(false);
    expect(mustMaskContacts("manager")).toBe(false);
  });

  it("follows the permission matrix for every role", () => {
    for (const r of USER_ROLES) expect(mustMaskContacts(r)).toBe(!can(r, "can_view_contact_details"));
  });

  it("sales, accountant and the partner agent are masked; an unknown or missing role is masked (fail closed)", () => {
    expect(mustMaskContacts("sales")).toBe(true);
    expect(mustMaskContacts("accountant")).toBe(true);
    expect(mustMaskContacts("partner_agent")).toBe(true);
    expect(mustMaskContacts(null)).toBe(true);
    expect(mustMaskContacts("customer_admin")).toBe(true);
  });

  it("billing, support, delivery and sales_senior see real contacts", () => {
    for (const r of ["billing", "support", "delivery", "sales_senior"]) expect(mustMaskContacts(r)).toBe(false);
  });
});

describe("maskContactsInBody", () => {
  it("masks phone and email on a lead list read with named columns", () => {
    const out = JSON.parse(maskContactsInBody("leads", q("id,name,contact_phone,contact_email"), JSON.stringify([LEAD])));
    expect(out[0].contact_phone).toBe("••••••••3210");
    expect(out[0].contact_email).toBe("ra•••@shop.in");
    expect(out[0].name).toBe("Ravi");
  });

  it("masks with select=* (or no select) and leaves every other column alone", () => {
    for (const s of ["*", null]) {
      const out = JSON.parse(maskContactsInBody("leads", q(s), JSON.stringify([LEAD])));
      expect(out[0].contact_phone).not.toContain("98765");
      expect(out[0].notes).toBe(LEAD.notes);
    }
  });

  it("masks an aliased column under its alias", () => {
    const out = JSON.parse(maskContactsInBody("customers", q("id,mobile:contact_mobile"), JSON.stringify([{ id: "c1", mobile: "9876543210" }])));
    expect(out[0].mobile).toBe("••••••3210");
  });

  it("masks a single object (Accept: object) as well as an array", () => {
    const out = JSON.parse(maskContactsInBody("customers", q("*"), JSON.stringify({ id: "c1", contact_email: "pardeep@anutech.in" })));
    expect(out.contact_email).toBe("pa•••••@anutech.in");
  });

  it("masks a customer embedded in another table's rows (to-one and to-many)", () => {
    const body = [{ id: "i1", total: 100, customers: { name: "A", contact_phone: "9876543210" }, contacts: [{ email: "a@b.in", phone: "9123456789", whatsapp: "9123456789" }] }];
    const out = JSON.parse(maskContactsInBody("invoices", q("id,total,customers(name,contact_phone),contacts(*)"), JSON.stringify(body)));
    expect(out[0].customers.contact_phone).toBe("••••••3210");
    expect(out[0].contacts[0].email).toBe("a•••@b.in");
    expect(out[0].contacts[0].phone).toBe("••••••6789");
    expect(out[0].contacts[0].whatsapp).toBe("••••••6789");
    expect(out[0].total).toBe(100);
  });

  it("an embed by FK column name (customer_id(...)) is still masked", () => {
    const body = [{ id: "s1", customer_id: { contact_email: "x@y.in" } }];
    const out = JSON.parse(maskContactsInBody("subscriptions", q("id,customer_id(contact_email)"), JSON.stringify(body)));
    expect(out[0].customer_id.contact_email).toBe("x•••@y.in");
  });

  it("keeps null and empty values as they are, and does not mask twice", () => {
    const body = [{ contact_phone: null, contact_email: "" }, { contact_phone: "••••3210", contact_email: "ra•••@shop.in" }];
    const out = JSON.parse(maskContactsInBody("leads", q("*"), JSON.stringify(body)));
    expect(out[0]).toEqual({ contact_phone: null, contact_email: "" });
    expect(out[1]).toEqual(body[1]);
  });

  it("leaves a table with no contact columns untouched (same text back)", () => {
    const text = JSON.stringify([{ id: "x", email: "team@us.in" }]);
    expect(maskContactsInBody("users", q("id,email"), text)).toBe(text);
  });

  it("an unreadable body comes back as it was", () => {
    expect(maskContactsInBody("leads", q("*"), "not json")).toBe("not json");
  });
});

describe("touchesContactTables", () => {
  it("true for a contact table, an embed of one, or list_leads; false otherwise", () => {
    expect(touchesContactTables("leads", q("id"))).toBe(true);
    expect(touchesContactTables("invoices", q("id,customers(name)"))).toBe(true);
    expect(touchesContactTables("invoices", q("id,total"))).toBe(false);
    expect(touchesContactTables("rpc/list_leads", q(null))).toBe(true);
    expect(touchesContactTables("rpc/anything", q(null))).toBe(false);
  });
});

describe("the Leads page RPC (list_leads)", () => {
  it("masks every row's phone and email and leaves the cursor alone", () => {
    const body = { rows: [LEAD, { ...LEAD, id: "l2", contact_phone: null }], next_cursor: { id: "l2", created_at: "2026-10-23" } };
    const out = JSON.parse(maskContactsInBody("rpc/list_leads", q(null), JSON.stringify(body)));
    expect(out.rows[0].contact_phone).toBe("••••••••3210");
    expect(out.rows[0].contact_email).toBe("ra•••@shop.in");
    expect(out.rows[1].contact_phone).toBe(null);
    expect(out.next_cursor).toEqual(body.next_cursor);
  });

  it("another RPC comes back untouched", () => {
    const text = JSON.stringify({ contact_phone: "9876543210" });
    expect(maskContactsInBody("rpc/lead_counts", q(null), text)).toBe(text);
  });
});

describe("stripMaskedContactWrites — a masked value is never saved over the real one", () => {
  it("drops a masked phone from a PATCH but keeps the other fields", () => {
    const body = JSON.stringify({ name: "Ravi K", contact_phone: "••••••••3210", contact_email: "new@shop.in" });
    expect(JSON.parse(stripMaskedContactWrites("leads", body)!)).toEqual({ name: "Ravi K", contact_email: "new@shop.in" });
  });

  it("handles an array insert body", () => {
    const body = JSON.stringify([{ name: "A", phone: "••••6789" }, { name: "B", phone: "9123456789" }]);
    expect(JSON.parse(stripMaskedContactWrites("contacts", body)!)).toEqual([{ name: "A" }, { name: "B", phone: "9123456789" }]);
  });

  it("returns the same text when nothing is masked or the table has no contact columns", () => {
    const body = JSON.stringify({ contact_phone: "9876543210" });
    expect(stripMaskedContactWrites("leads", body)).toBe(body);
    expect(stripMaskedContactWrites("invoices", JSON.stringify({ x: "•" }))).toBe(JSON.stringify({ x: "•" }));
    expect(stripMaskedContactWrites("leads", null)).toBe(null);
  });
});

describe("the column list", () => {
  it("names the contact columns of leads, customers and contacts", () => {
    expect(CONTACT_COLUMNS.leads).toEqual(["contact_email", "contact_phone"]);
    expect(CONTACT_COLUMNS.customers).toEqual(["contact_email", "contact_phone", "contact_mobile"]);
    expect(CONTACT_COLUMNS.contacts).toEqual(["email", "phone", "whatsapp"]);
  });

  it("isMaskedContact spots a masked value", () => {
    expect(isMaskedContact("••••3210")).toBe(true);
    expect(isMaskedContact("9876543210")).toBe(false);
    expect(isMaskedContact(null)).toBe(false);
  });
});
