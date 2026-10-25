// @vitest-environment jsdom
//
// A customer's contacts — the rules that must hold on screen.
//
// ─── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// The same fact used to live in three places, two of them dead: the flat
// `customers.contact_*` columns, a `contact_persons` jsonb nobody filled, and a
// `contacts` table with a `customer_id` and zero rows. Abhishek's decision, 10 Sep
// 2026: ONE identity — several people per customer, with roles, at least one
// mandatory, and one PRIMARY who receives invoices and payment reminders.
//
// Two of those rules are easy to lose in a refactor and expensive to lose in
// production: the first contact must become primary automatically (otherwise an
// invoice has nobody to go to), and the last contact must not be removable
// (otherwise a customer exists that cannot be invoiced or chased). Both are pinned
// here; the database backs the primary rule with a UNIQUE index.
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { CustomerContactsCard } from "./customer-contacts-card";
import type { Contact } from "@/lib/queries/contacts";

/** What the mocked hooks report and record. */
const state: {
  contacts: Contact[];
  created: Array<Record<string, unknown>>;
  updated: Array<Record<string, unknown>>;
  primaried: Array<{ contactId: string; customerId: string }>;
  removed: Array<{ contactId: string; customerId: string }>;
  /** contact id → how many customers they serve, behind the "Serves N customers" chip. */
  serves: Map<string, number>;
} = { contacts: [], created: [], updated: [], primaried: [], removed: [], serves: new Map() };

vi.mock("@/lib/queries/contacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/contacts")>();
  return {
    ...actual,   // keeps CONTACT_ROLES + roleLabel real, so the labels under test are the shipped ones
    useCustomerContacts: () => ({ data: state.contacts, isLoading: false }),
    useCreateContact: () => ({
      mutateAsync: async (v: Record<string, unknown>) => { state.created.push(v); return "new-id"; },
      isPending: false,
    }),
    useUpdateContact: () => ({
      mutateAsync: async (v: Record<string, unknown>) => { state.updated.push(v); },
      isPending: false,
    }),
    useSetPrimaryContact: () => ({
      mutate: (v: { contactId: string; customerId: string }) => state.primaried.push(v),
    }),
    useDeleteCustomerContact: () => ({
      mutate: (v: { contactId: string; customerId: string }) => state.removed.push(v),
    }),
    useContactSearchIndex: () => ({
      data: {
        textByCustomer: new Map<string, string>(),
        customerCountByContact: state.serves,
        customerIdsByContact: new Map<string, string[]>(),
      },
    }),
  };
});

const contact = (over: Partial<Contact> = {}): Contact => ({
  id: "c1", tenant_id: "t1", customer_id: "cust1",
  full_name: "Rajesh K", email: "rajesh@chandan.in", phone: "+91 98765 43210",
  title: "CTO", role: "poc", is_primary: true,
  ...over,
} as unknown as Contact);

beforeEach(() => {
  state.contacts = []; state.created = []; state.updated = [];
  state.primaried = []; state.removed = []; state.serves = new Map();
});
afterEach(cleanup);

const open = () => render(<CustomerContactsCard customerId="cust1" customerName="Chandan Trading" />);

describe("Customer contacts — what is on screen", () => {
  it("marks the primary and names each role", () => {
    state.contacts = [
      contact(),
      contact({ id: "c2", full_name: "Sunita M", role: "accountant", is_primary: false }),
    ];
    open();
    expect(screen.getByText("Primary")).toBeDefined();
    expect(screen.getByText("Point of contact")).toBeDefined();
    expect(screen.getByText("Accountant")).toBeDefined();
  });

  it("warns loudly when a customer has NO contact", () => {
    /* Should not happen — but if it does, invoices and reminders have nowhere to go,
       and an empty box would leave the operator to work that out. */
    open();
    expect(screen.getByText("This customer has no contact")).toBeDefined();
    expect(document.body.textContent).toContain("Invoices and payment reminders have nowhere to go");
  });

  it("R-1670 (5): a contact on the customer record (header shows it) is not called 'no contact'", () => {
    /* T-1 on staging: the header showed the person from customers.contact_* while this card
       said "This customer has no contact" — reminders DO go there (renewals read contact_email). */
    render(
      <CustomerContactsCard
        customerId="cust1"
        customerName="Chandan Trading"
        recordContact={{ name: "Rajesh K", title: null, phone: "+91 98765 43210", email: "rajesh@chandan.in" }}
      />,
    );
    expect(screen.queryByText("This customer has no contact")).toBeNull();
    expect(document.body.textContent).toContain("Rajesh K");
    expect(document.body.textContent).toContain("rajesh@chandan.in");
    /* One click turns it into a real contact person (prefilled), the first → primary. */
    fireEvent.click(screen.getByRole("button", { name: "Save as contact" }));
    expect((screen.getByLabelText(/name/i, { selector: "input" }) as HTMLInputElement).value).toBe("Rajesh K");
  });

  it("R-1893: the primary row shows the customer's mobile when the contact has no phone, tap to call", () => {
    /* Pardeep, 25 Oct: "Anil Tayal · Primary · Point of contact · office2@…" and no phone,
       though the mobile was typed in the customer form. */
    state.contacts = [
      contact({ full_name: "Anil Tayal", phone: null, title: null, email: "office2@example.in" }),
      contact({ id: "c2", full_name: "Sunita M", phone: null, is_primary: false, title: null, email: "s@example.in" }),
    ];
    render(<CustomerContactsCard customerId="cust1" customerName="Anil Tayal Co" recordPhone="9876543210" />);
    const call = screen.getByRole("link", { name: /98765 43210/ });
    expect(call.getAttribute("href")).toBe("tel:9876543210");
    /* Only the primary takes the customer's number — Sunita is someone else. */
    expect(screen.getAllByRole("link", { name: /98765 43210/ })).toHaveLength(1);
  });

  it("R-1893: a contact's own phone is shown as a tap-to-call link", () => {
    state.contacts = [contact({ phone: "+91 98765 43210" })];
    render(<CustomerContactsCard customerId="cust1" customerName="Chandan Trading" recordPhone="9111111111" />);
    expect(screen.getByRole("link", { name: /98765 43210/ }).getAttribute("href")).toBe("tel:+919876543210");
    expect(document.body.textContent).not.toContain("91111");
  });

  it("offers 'Make primary' only on contacts that are not already primary", () => {
    state.contacts = [
      contact(),
      contact({ id: "c2", full_name: "Sunita M", is_primary: false }),
    ];
    open();
    /* One button, for Sunita — not two. */
    expect(screen.getAllByText("Make primary")).toHaveLength(1);
  });

  it("switching the primary sends both ids, so the old one can be demoted", () => {
    state.contacts = [
      contact(),
      contact({ id: "c2", full_name: "Sunita M", is_primary: false }),
    ];
    open();
    fireEvent.click(screen.getByText("Make primary"));
    expect(state.primaried).toEqual([{ contactId: "c2", customerId: "cust1" }]);
  });
});

describe("Adding a contact", () => {
  it("makes the FIRST contact primary automatically", async () => {
    /* Nobody should have to tick a box on the only available option — and an
       unset primary means an invoice with no recipient. */
    open();
    fireEvent.click(screen.getByText("Add contact"));
    fireEvent.change(document.querySelector<HTMLInputElement>("#ct_name")!,
      { target: { value: "Rajesh K" } });
    fireEvent.click(screen.getByText("Save contact"));
    await waitFor(() => expect(state.created).toHaveLength(1));
    expect(state.created[0]).toMatchObject({
      full_name: "Rajesh K", customer_id: "cust1", is_primary: true,
    });
  });

  it("does NOT make a later contact primary", async () => {
    state.contacts = [contact()];
    open();
    fireEvent.click(screen.getByText("Add contact"));
    fireEvent.change(document.querySelector<HTMLInputElement>("#ct_name")!,
      { target: { value: "Sunita M" } });
    fireEvent.click(screen.getByText("Save contact"));
    await waitFor(() => expect(state.created).toHaveLength(1));
    expect(state.created[0].is_primary).toBe(false);
  });

  it("refuses a nameless contact — the name is what appears on a reminder", async () => {
    open();
    fireEvent.click(screen.getByText("Add contact"));
    fireEvent.click(screen.getByText("Save contact"));
    /* Nothing written, and the dialog stays open so the operator can fix it. */
    await waitFor(() => expect(state.created).toHaveLength(0));
    expect(document.querySelector("#ct_name")).not.toBeNull();
  });

  it("stamps the customer and the default role onto a new contact", async () => {
    state.contacts = [contact()];
    open();
    fireEvent.click(screen.getByText("Add contact"));
    fireEvent.change(document.querySelector<HTMLInputElement>("#ct_name")!,
      { target: { value: "Sunita M" } });
    fireEvent.click(screen.getByText("Save contact"));
    await waitFor(() => expect(state.created).toHaveLength(1));
    /* `company` carries the customer's name so a contact read on its own still says
       who it belongs to, and `role` defaults to point-of-contact. */
    expect(state.created[0]).toMatchObject({
      role: "poc", company: "Chandan Trading", customer_id: "cust1",
    });
  });

  /* NOT asserted: PICKING a different role in the dropdown. Radix only renders the
     hidden native <select> that jsdom can drive when the control sits inside a
     <form>, and this dialog has none — so there is no way to change it here without
     faking the interaction. The role's journey from state to the write IS covered
     above (the default reaches `created`), and CONTACT_ROLES is a real import in this
     file so a renamed value would fail to compile. Recorded so the next person does
     not read the gap as an oversight. */
});

describe("Editing and removing", () => {
  it("edits in place rather than creating a second person", async () => {
    state.contacts = [contact()];
    open();
    fireEvent.click(screen.getByLabelText("Edit Rajesh K"));
    fireEvent.change(document.querySelector<HTMLInputElement>("#ct_name")!,
      { target: { value: "Rajesh Kumar" } });
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() => expect(state.updated).toHaveLength(1));
    expect(state.created).toHaveLength(0);
    expect(state.updated[0]).toMatchObject({ id: "c1" });
  });

  it("passes a removal to the hook, which is where the last-contact rule lives", () => {
    /* The refusal is enforced in useDeleteCustomerContact — it counts the rows first,
       so the rule holds no matter which screen calls it. Enforcing it only here would
       leave it enforced nowhere that matters. */
    state.contacts = [contact(), contact({ id: "c2", full_name: "Sunita M", is_primary: false })];
    open();
    fireEvent.click(screen.getByLabelText("Remove Sunita M"));
    expect(state.removed).toEqual([{ contactId: "c2", customerId: "cust1" }]);
  });
});

/**
 * ─── "Serves 3 customers" ────────────────────────────────────────────────────
 *
 * Since 18 Sep 2026 one person can look after several companies. Until the number is on
 * screen the capability is invisible — this card looks identical whether Anjali is on one
 * customer or five, so the operator has no way to know that editing her here touches a
 * relationship that exists elsewhere too.
 */
describe("Serves N customers", () => {
  it("shows the count, and links to Customers filtered to that person", () => {
    state.contacts = [contact({ id: "C-ANJALI", full_name: "Anjali Tomar", email: "anjali@doodhsang.in" })];
    state.serves = new Map([["C-ANJALI", 3]]);
    open();

    const chip = screen.getByText("Serves 3 customers");
    expect(chip.closest("a")?.getAttribute("href"))
      .toBe("/customers?contact=anjali%40doodhsang.in");
  });

  it("stays silent at one customer — 'Serves 1 customer' on every row is noise", () => {
    state.contacts = [contact({ id: "C-SOLO", full_name: "Ranjeet Kumar" })];
    state.serves = new Map([["C-SOLO", 1]]);
    open();

    expect(screen.queryByText(/Serves/)).toBeNull();
  });

  it("falls back to the name when the person has no email to filter by", () => {
    state.contacts = [contact({ id: "C-NOMAIL", full_name: "Sunita Rao", email: null })];
    state.serves = new Map([["C-NOMAIL", 2]]);
    open();

    expect(screen.getByText("Serves 2 customers").closest("a")?.getAttribute("href"))
      .toBe("/customers?contact=Sunita%20Rao");
  });
});
