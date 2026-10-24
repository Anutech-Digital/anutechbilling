/**
 * R-1821 (24 Oct 2026, security audit) — a masked role could not SEE a phone, but could still
 * ASK about it: a filter / order on a masked column runs on the real value, so
 *   GET leads?select=id&contact_phone=like.*98765*      (grow the pattern digit by digit)
 *   GET leads?select=id&order=contact_phone             (sort reveals the order of the numbers)
 * recovered the number. maskedQueryRefusal() refuses those for a masked role (the route answers
 * 400); owner / manager never reach it (mustMaskContacts is false for them). Each probe failed
 * before the fix (the function did not exist, so nothing was refused).
 */
import { describe, it, expect } from "vitest";
import { maskContactsInBody, maskedQueryRefusal, isContactSearch, mustMaskContacts } from "./contact-mask";

const p = (qs: string) => new URLSearchParams(qs);
const refused = (path: string, qs: string, body: string | null = null) => maskedQueryRefusal(path, p(qs), body);

describe("R-1821: filters / order / cast on a masked column are refused", () => {
  it("probe: like on contact_phone (the digit-by-digit attack)", () => {
    expect(refused("leads", "select=id&contact_phone=like.*98765*")).toMatch(/cannot filter by a phone number or email \(leads\.contact_phone\)/);
  });

  it("probe: order=contact_phone (and desc / nulls modifiers)", () => {
    expect(refused("leads", "select=id&order=contact_phone")).toMatch(/cannot sort by/);
    expect(refused("leads", "select=id&order=created_at.desc,contact_email.asc.nullslast")).toMatch(/contact_email/);
  });

  it("probe: inside or= / and= / not.or=, nested", () => {
    expect(refused("leads", "select=id&or=(company.ilike.*acme*,contact_phone.ilike.*987*)")).not.toBeNull();
    expect(refused("customers", "select=id&and=(name.eq.x,or(contact_mobile.like.98*,id.eq.1))")).not.toBeNull();
    expect(refused("contacts", "select=id&not.or=(email.ilike.*a*)")).not.toBeNull();
  });

  it("probe: every operator, negated too, and range ops (binary search)", () => {
    for (const f of ["eq.9876543210", "neq.x", "gt.98", "lte.99", "in.(1,2)", "not.ilike.*9*", "match.^98", "imatch.x", "isdistinct.x"]) {
      expect(refused("contacts", `select=id&phone=${f}`), f).not.toBeNull();
    }
  });

  it("probe: jsonb contact lists and customer_groups (R-1820 columns)", () => {
    expect(refused("contacts", 'select=id&emails=cs.[{"value":"ravi@shop.in"}]')).not.toBeNull();
    expect(refused("customers", "select=id&contact_persons=cs.[]")).not.toBeNull();
    expect(refused("customer_groups", "select=id&contact_phone=like.98*")).not.toBeNull();
  });

  it("probe: a filter on an embedded table, by relation name or alias (with !inner it filters the parent)", () => {
    expect(refused("invoices", "select=id,customers!inner(id)&customers.contact_phone=like.98*")).toMatch(/customers\.contact_phone/);
    expect(refused("invoices", "select=id,c:customer_id!inner(id)&c.contact_email=ilike.*a*")).not.toBeNull();
    expect(refused("customers", "select=id,g:customer_groups(id)&g.order=contact_phone")).toMatch(/sort by/);
  });

  it("probe: a cast on a masked column (a number would skip the string masker)", () => {
    expect(refused("leads", "select=id,contact_phone::int8")).toMatch(/cannot convert/);
    expect(refused("contacts", "select=id,emails::text")).not.toBeNull();
  });

  it("probe: PATCH / DELETE filters ask the same question (rows affected)", () => {
    // the method does not matter — the route checks every request
    expect(refused("leads", "contact_phone=like.98*", JSON.stringify({ notes: "x" }))).not.toBeNull();
  });

  it("still allowed: other columns, select of the masked column, and is.null ('has an email')", () => {
    expect(refused("leads", "select=id,contact_phone,contact_email&company=ilike.*acme*&order=created_at.desc")).toBeNull();
    expect(refused("leads", "select=id&contact_email=not.is.null")).toBeNull();
    expect(refused("leads", "select=id&or=(contact_phone.is.null,contact_email.is.null)")).toBeNull();
    expect(refused("quotes", "select=id&email=eq.x")).toBeNull(); // not a masked table
  });

  it("owner and manager are never checked (not masked)", () => {
    expect(mustMaskContacts("owner")).toBe(false);
    expect(mustMaskContacts("manager")).toBe(false);
  });
});

describe("R-1821: list_leads / lead_counts search by phone or email is refused", () => {
  it("probe: a phone-like or email search, in the POST body or GET p_filters", () => {
    expect(refused("rpc/list_leads", "", JSON.stringify({ p_filters: { search: "98765" } }))).toMatch(/cannot search by/);
    expect(refused("rpc/lead_counts", "", JSON.stringify({ p_filters: { search: "ravi@" } }))).not.toBeNull();
    expect(refused("rpc/list_leads", `p_filters=${encodeURIComponent(JSON.stringify({ search: "+91 98765" }))}`)).not.toBeNull();
  });

  it("a name / company search and short numbers pass", () => {
    expect(refused("rpc/list_leads", "", JSON.stringify({ p_filters: { search: "acme" } }))).toBeNull();
    expect(refused("rpc/list_leads", "", JSON.stringify({ p_filters: { search: "L-0042" } }))).toBeNull();
    expect(isContactSearch("1234")).toBe(false);
    expect(isContactSearch("98765 43210")).toBe(true);
  });
});

describe("R-1821: find_lead_duplicates does not say which contact matched", () => {
  const rows = [
    { id: "L-1", company: "Acme", matched_on: ["phone"] },
    { id: "L-2", company: "Beta", matched_on: ["gstin", "email"] },
  ];
  it("probe: matched_on is 'possible' for a masked role", () => {
    const out = JSON.parse(maskContactsInBody("rpc/find_lead_duplicates", p(""), JSON.stringify(rows)));
    expect(out.map((r: { matched_on: string[] }) => r.matched_on)).toEqual([["possible"], ["possible"]]);
    expect(out[0].company).toBe("Acme");
  });
});
