/**
 * R-1820 (24 Oct 2026, security audit) — probes: the R-1009 masker missed jsonb contact lists
 * and customer_groups. An accountant's
 *   GET /api/sb/rest/v1/contacts?select=id,full_name,emails,phones
 * came back with every number and email in clear text. Each probe below failed before the fix.
 */
import { describe, it, expect } from "vitest";
import { maskContactsInBody, stripMaskedContactWrites, touchesContactTables } from "./contact-mask";

const q = (select: string | null) => {
  const s = new URLSearchParams();
  if (select !== null) s.set("select", select);
  return s;
};
const REAL = ["98765", "43210", "ravi@shop.in", "asha@acme.in", "91234"];
const leaks = (text: string) => REAL.filter((r) => text.includes(r));

const CONTACT = {
  id: "k1", full_name: "Ravi",
  emails: [{ value: "ravi@shop.in", label: "work" }, { value: "asha@acme.in", label: "home" }],
  phones: [{ value: "+91 98765 43210", label: "mobile" }, { value: "9123456789", label: "office" }],
};
const CUSTOMER = {
  id: "c1", name: "Acme",
  contact_persons: [
    { salutation: "Mr", first_name: "Ravi", last_name: "K", email: "ravi@shop.in", phone: "+91 98765 43210", mobile: "9123456789", designation: "Accounts" },
  ],
};
const GROUP = { id: "g1", name: "Acme Group", contact_email: "asha@acme.in", contact_phone: "9876543210" };

describe("R-1820: jsonb contact lists are masked", () => {
  it("probe: contacts?select=id,full_name,emails,phones leaks nothing", () => {
    const out = maskContactsInBody("contacts", q("id,full_name,emails,phones"), JSON.stringify([CONTACT]));
    expect(leaks(out)).toEqual([]);
    const row = JSON.parse(out)[0];
    expect(row.emails[0]).toEqual({ value: "ra•••@shop.in", label: "work" });
    expect(row.phones[0].value).toBe("••••••••3210");
    expect(row.phones[0].label).toBe("mobile");
    expect(row.full_name).toBe("Ravi");
  });

  it("probe: contacts with select=* and with no select", () => {
    for (const s of ["*", null]) expect(leaks(maskContactsInBody("contacts", q(s), JSON.stringify([CONTACT])))).toEqual([]);
  });

  it("probe: customers.contact_persons — email / phone / mobile masked, names and designation kept", () => {
    const out = maskContactsInBody("customers", q("id,name,contact_persons"), JSON.stringify([CUSTOMER]));
    expect(leaks(out)).toEqual([]);
    const p = JSON.parse(out)[0].contact_persons[0];
    expect(p.first_name).toBe("Ravi");
    expect(p.designation).toBe("Accounts");
    expect(p.salutation).toBe("Mr");
    expect(p.mobile).toBe("••••••6789");
  });

  it("probe: an aliased jsonb column is masked under its alias", () => {
    const out = maskContactsInBody("contacts", q("id,mails:emails"), JSON.stringify([{ id: "k1", mails: CONTACT.emails }]));
    expect(leaks(out)).toEqual([]);
  });

  it("probe: a jsonb list embedded from another table (contacts through customers)", () => {
    const body = [{ id: "c1", contacts: [CONTACT] }];
    const out = maskContactsInBody("customers", q("id,contacts(id,emails,phones)"), JSON.stringify(body));
    expect(leaks(out)).toEqual([]);
  });

  it("a plain string inside a list (no {value}) is masked too — fail closed", () => {
    const out = maskContactsInBody("contacts", q("id,phones"), JSON.stringify([{ id: "k1", phones: ["9876543210"] }]));
    expect(leaks(out)).toEqual([]);
  });

  it("a number (a cast, or a phone saved as a number) is masked", () => {
    const out = maskContactsInBody("leads", q("id,contact_phone"), JSON.stringify([{ id: "l1", contact_phone: 9876543210 }]));
    expect(leaks(out)).toEqual([]);
  });
});

describe("R-1820: customer_groups contact columns are masked", () => {
  it("probe: customer_groups read directly", () => {
    expect(touchesContactTables("customer_groups", q("id,contact_phone"))).toBe(true);
    const out = maskContactsInBody("customer_groups", q("id,name,contact_email,contact_phone"), JSON.stringify([GROUP]));
    expect(leaks(out)).toEqual([]);
    expect(JSON.parse(out)[0].name).toBe("Acme Group");
  });

  it("probe: customer_groups embedded from customers", () => {
    const body = [{ id: "c1", name: "Acme", group: GROUP }];
    const s = q("id,name,group:customer_groups(id,name,contact_email,contact_phone)");
    expect(touchesContactTables("customers", s)).toBe(true);
    expect(leaks(maskContactsInBody("customers", s, JSON.stringify(body)))).toEqual([]);
  });
});

describe("R-1820: masked values are never written back", () => {
  it("a jsonb list holding a masked value is dropped whole; the rest of the edit is kept", () => {
    const body = JSON.stringify({ full_name: "Ravi K", emails: [{ value: "ra•••@shop.in", label: "work" }], phones: [{ value: "9123456789", label: "x" }] });
    const out = JSON.parse(stripMaskedContactWrites("contacts", body)!);
    expect(out).toEqual({ full_name: "Ravi K", phones: [{ value: "9123456789", label: "x" }] });
  });

  it("customers.contact_persons with a masked phone is dropped", () => {
    const body = JSON.stringify({ name: "Acme", contact_persons: [{ first_name: "Ravi", phone: "••••••3210" }] });
    expect(JSON.parse(stripMaskedContactWrites("customers", body)!)).toEqual({ name: "Acme" });
  });

  it("customer_groups masked contact columns are dropped", () => {
    const body = JSON.stringify({ name: "G", contact_phone: "••••••3210", contact_email: "as•••@acme.in" });
    expect(JSON.parse(stripMaskedContactWrites("customer_groups", body)!)).toEqual({ name: "G" });
  });

  it("a real (typed) list is left alone", () => {
    const body = JSON.stringify({ emails: [{ value: "new@acme.in", label: "work" }] });
    expect(stripMaskedContactWrites("contacts", body)).toBe(body);
  });
});
