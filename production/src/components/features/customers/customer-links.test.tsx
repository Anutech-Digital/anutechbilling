// @vitest-environment jsdom
//
// R-1521 / R-1522 (17 Oct 2026, Pardeep) — the customer page's links and contact line.
//   R-1521: a Transactions row did nothing on click (INV-A378-27-0001). Every row now opens
//           its own document, and the reference is a real link (keyboard, Ctrl+click).
//   R-1522: the Overview card showed the COMPANY name where the contact person belongs
//           ("GL · GREENTIN SOLUTIONS PRIVATE LIMITED").
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import type { Customer } from "@/lib/supabase/database.types";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { txnHref, primaryContactOf, isCompanyName } from "./customer-links";
import { RecordTable, RowLink } from "./customer-record-table";
import { PrimaryContactLine } from "./primary-contact-line";
import { CustomerIdentityRail } from "./customer-insights";

afterEach(() => { cleanup(); push.mockReset(); });

describe("R-1521: every transaction type has its own address", () => {
  const can = { canQuotes: true };
  it("invoice → /invoices/<id> (encoded, a series prefix may hold a slash)", () => {
    expect(txnHref({ kind: "invoice", invoiceId: "INV-A378-27-0001" }, can)).toBe("/invoices/INV-A378-27-0001");
    expect(txnHref({ kind: "invoice", invoiceId: "ANU/26-27/001" }, can)).toBe("/invoices/ANU%2F26-27%2F001");
  });
  it("quote → /quotes/<id>, and nothing for a role that cannot open quotes (R-237)", () => {
    expect(txnHref({ kind: "quote", quoteId: "Q-12" }, can)).toBe("/quotes/Q-12");
    expect(txnHref({ kind: "quote", quoteId: "Q-12" }, { canQuotes: false })).toBeNull();
  });
  it("payment → the quote it paid; without quote access → that customer's receipts", () => {
    expect(txnHref({ kind: "payment", quoteId: "Q-12", customerId: "c-1" }, can)).toBe("/quotes/Q-12");
    expect(txnHref({ kind: "payment", quoteId: "Q-12", customerId: "c-1" }, { canQuotes: false })).toBe("/payments?customer=c-1");
    expect(txnHref({ kind: "payment", quoteId: null, customerId: "c-1" }, can)).toBe("/payments?customer=c-1");
  });
  it("project payment → its invoice, else its project; project → /projects/<id>", () => {
    expect(txnHref({ kind: "projectPayment", invoiceId: "INV-9", projectId: "p-1" }, can)).toBe("/invoices/INV-9");
    expect(txnHref({ kind: "projectPayment", invoiceId: null, projectId: "p-1" }, can)).toBe("/projects/p-1");
    expect(txnHref({ kind: "project", projectId: "p-1" }, can)).toBe("/projects/p-1");
  });
});

describe("R-1521: a row is a link, on desktop and on the phone", () => {
  const rows = [
    { href: "/invoices/INV-1" as const, label: "Open invoice INV-1", cells: ["1 Oct", "Invoice", <RowLink key="r" href={"/invoices/INV-1" as never}>INV-1</RowLink>] },
    { href: "/quotes/Q-1" as const, label: "Open quote Q-1", cells: ["2 Oct", "Quote", <RowLink key="r" href={"/quotes/Q-1" as never}>Q-1</RowLink>] },
    { href: null, cells: ["3 Oct", "Payment", <RowLink key="r" href={null}>RV-1</RowLink>] },
  ];

  it("the reference is a real <a href> in both the table and the phone card", () => {
    render(<RecordTable head={["Date", "Type", "Reference"]} rows={rows as never} />);
    const inv = screen.getAllByRole("link", { name: "INV-1" });
    expect(inv).toHaveLength(2);
    inv.forEach((a) => expect(a.getAttribute("href")).toBe("/invoices/INV-1"));
    expect(screen.getAllByRole("link", { name: "Q-1" })[0].getAttribute("href")).toBe("/quotes/Q-1");
    // No address → plain text, never a dead link.
    expect(screen.queryByRole("link", { name: "RV-1" })).toBeNull();
  });

  it("clicking anywhere on the row opens it; Ctrl+click opens a new tab", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { container } = render(<RecordTable head={["Date", "Type", "Reference"]} rows={rows as never} />);
    const tr = container.querySelector('tr[data-href="/invoices/INV-1"]')!;
    fireEvent.click(within(tr as HTMLElement).getByText("Invoice"));
    expect(push).toHaveBeenCalledWith("/invoices/INV-1");
    fireEvent.click(within(tr as HTMLElement).getByText("Invoice"), { ctrlKey: true });
    expect(open).toHaveBeenCalledWith("/invoices/INV-1", "_blank", "noopener");
    open.mockRestore();
  });

  it("the phone card opens with Enter", () => {
    render(<RecordTable head={["Date", "Type", "Reference"]} rows={rows as never} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Open quote Q-1" }), { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/quotes/Q-1");
  });
});

describe("R-1522: the contact person, never the company name", () => {
  const company = { name: "GREENTIN SOLUTIONS PRIVATE LIMITED", display_name: null };

  it("the primary linked contact wins, then the flat columns", () => {
    const got = primaryContactOf(company, [
      { full_name: "Ravi", is_primary: false },
      { full_name: "Anjali Mehra", title: "Accounts Head", phone: "9876543210", email: "a@g.in", is_primary: true },
    ]);
    expect(got).toEqual({ name: "Anjali Mehra", title: "Accounts Head", phone: "9876543210", email: "a@g.in" });
    expect(primaryContactOf({ ...company, contact_name: "Ravi K", contact_phone: "98" }, [])?.name).toBe("Ravi K");
  });

  it("a contact named like the company (import mistake) counts as no contact", () => {
    expect(isCompanyName("Greentin Solutions Private Limited", company)).toBe(true);
    expect(primaryContactOf({ ...company, contact_name: "GREENTIN SOLUTIONS PRIVATE LIMITED" }, [])).toBeNull();
    expect(primaryContactOf(company, [{ full_name: "greentin solutions private limited", is_primary: true }])).toBeNull();
    expect(primaryContactOf(company, null)).toBeNull();
  });

  it("header line: name · designation · tel: · mailto:", () => {
    render(<PrimaryContactLine contact={{ name: "Anjali Mehra", title: "Accounts Head", phone: "98765 43210", email: "a@g.in" }} />);
    const line = screen.getByTestId("header-contact");
    expect(line.textContent).toContain("Anjali Mehra");
    expect(line.textContent).toContain("Accounts Head");
    expect(within(line).getByRole("link", { name: /a@g\.in/ }).getAttribute("href")).toBe("mailto:a@g.in");
    expect(line.querySelector('a[href="tel:9876543210"]')).not.toBeNull();
  });

  it("header line with no contact: says so and offers Add contact", () => {
    const add = vi.fn();
    render(<PrimaryContactLine contact={null} onAddContact={add} />);
    expect(screen.getByTestId("header-no-contact").textContent).toContain("Koi contact person nahi");
    fireEvent.click(screen.getByRole("button", { name: /Add contact/ }));
    expect(add).toHaveBeenCalledOnce();
  });

  it("identity card with no contact never shows the company name as the person", () => {
    const add = vi.fn();
    const c = { ...company, id: "c-1", contact_name: "GREENTIN SOLUTIONS PRIVATE LIMITED", country: "India" } as unknown as Customer;
    render(<CustomerIdentityRail c={c} contact={primaryContactOf(c, [])} onAddContact={add} />);
    const card = screen.getByTestId("no-contact-person");
    expect(card.textContent).toContain("Koi contact person nahi");
    expect(card.textContent).not.toContain("GREENTIN");
    fireEvent.click(within(card).getByRole("button", { name: /Add contact/ }));
    expect(add).toHaveBeenCalledOnce();
  });

  it("identity card with a contact shows the person with call / mail", () => {
    const c = { ...company, id: "c-1", country: "India" } as unknown as Customer;
    render(<CustomerIdentityRail c={c} contact={{ name: "Anjali Mehra", title: "CFO", phone: "9876543210", email: "a@g.in" }} />);
    expect(screen.getByText("Anjali Mehra")).toBeTruthy();
    expect(screen.queryByTestId("no-contact-person")).toBeNull();
    expect(document.querySelector('a[href="tel:9876543210"]')).not.toBeNull();
    expect(document.querySelector('a[href="mailto:a@g.in"]')).not.toBeNull();
  });
});
