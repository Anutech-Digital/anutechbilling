// @vitest-environment jsdom
//
// R-818: every open of "1-Click Onboard Subscription" is a FRESH form.
//
// ─── WHY THIS TEST EXISTS ───────────────────────────────────────────────────
// Abhishek, staging, 10 Oct 2026: onboard a customer, confirm the payment, open the
// dialog again — and the previous customer's company name, domain, contact person,
// phone, email and state were still filled in. The page keeps the dialog mounted and
// only flips `open`, so its useState values survived the close. The next customer
// could have been onboarded under the last one's details.
//
// Decided in the fix: there is no deliberate draft. A successful submit AND a plain
// close both give an empty form on the next open.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddSubscriptionDialog } from "./add-subscription-dialog";
import type { LeadPrefill } from "@/lib/subscriptions/lead-prefill";

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { id: "u1", tenantId: "t1", role: "owner" } }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [], isLoading: false }) }));

const writes: string[] = [];
let customerRows: Array<{ id: string; name: string; domain: string | null }> = [];

/** Awaitable at any point of the chain, like the paid-handoff harness. */
function chainOf(rows: unknown[]) {
  const settled = Promise.resolve({ data: rows, error: null });
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, or: () => chain, ilike: () => chain,
    order: () => chain, limit: () => chain,
    then: (...a: unknown[]) => (settled.then as (...x: unknown[]) => unknown)(...a),
  };
  return chain;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: "Q-ADPL-2026-27-0001", error: null }),
    from: (table: string) => ({
      ...chainOf(table === "customers" ? customerRows : []),
      insert: async () => { writes.push(table); return { error: null }; },
      upsert: async () => { writes.push(table); return { error: null }; },
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

afterEach(() => {
  cleanup();
  writes.length = 0;
  customerRows = [];
});

/** The page's shape: the dialog stays mounted, a button flips `open`. */
function Host() {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>reopen</button>
      <AddSubscriptionDialog open={open} onOpenChange={setOpen} onSuccess={() => {}} />
    </>
  );
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><Host /></QueryClientProvider>);
}

const field = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`);
const set = (id: string, value: string) => fireEvent.change(field(id)!, { target: { value } });

function fillCustomer() {
  set("custName", "Accesstel");
  set("subDomain", "accesstel.in");
  set("contactName", "Ranjeet Kumar");
  set("contactEmail", "ranjeet@accesstel.in");
  set("contactPhone", "+91 98765 43210");
  set("newCustState", "07");
  set("pricePerSeat", "1632");
  set("seats", "25");
  set("paymentDueDate", "2026-10-11");
}

function expectBlank() {
  expect(field("custName")?.value).toBe("");
  expect(field("subDomain")?.value).toBe("");
  expect(field("contactName")?.value).toBe("");
  expect(field("contactEmail")?.value).toBe("");
  expect(field("contactPhone")?.value).toBe("");
  expect(field("newCustState")?.value ?? "").toBe("");
  expect(field("seats")?.value).toBe("10");          // the default, not the last sale's 25
  expect(field("paymentDueDate")?.value ?? "").toBe("");
}

const reopen = () => fireEvent.click(document.querySelector('[data-testid="reopen"]')!);

describe("R-818 — onboarding dialog opens empty every time", () => {
  it("after a successful submit, reopening shows an empty form", async () => {
    mount();
    fillCustomer();
    expect(field("custName")?.value).toBe("Accesstel");
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(writes).toContain("subscriptions"));
    /* The success path closes the dialog itself. */
    await waitFor(() => expect(field("custName")).toBeNull());

    reopen();
    await waitFor(() => expect(field("custName")).not.toBeNull());
    expectBlank();
  });

  it("closing without submitting does not keep a draft either", async () => {
    mount();
    fillCustomer();
    const cancel = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.textContent ?? "").trim() === "Cancel")!;
    fireEvent.click(cancel);
    await waitFor(() => expect(field("custName")).toBeNull());

    reopen();
    await waitFor(() => expect(field("custName")).not.toBeNull());
    expectBlank();
    expect(writes).toEqual([]);
  });

  it("a picked existing customer does not stay picked on the next open", async () => {
    customerRows = [{ id: "c-1", name: "Old Customer Pvt Ltd", domain: "old.in" }];
    mount();
    set("custName", "Old Customer Pvt Ltd");
    set("subDomain", "old.in");
    const cancel = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.textContent ?? "").trim() === "Cancel")!;
    fireEvent.click(cancel);
    await waitFor(() => expect(field("custName")).toBeNull());

    reopen();
    await waitFor(() => expect(field("custName")).not.toBeNull());
    expect(field("custName")?.value).toBe("");
    /* The contact block only shows for a NEW customer — present means nothing is picked. */
    expect(field("contactName")).not.toBeNull();
  });
});

/* A picked customer, reached through the same handleSelectExistingCustomer path the
   dropdown uses (the won-deal prefill calls it) — Radix Select cannot be driven in jsdom. */
function mountWithPickedCustomer() {
  customerRows = [{ id: "c-1", name: "Excel Technologies", domain: "exceltechnologies.in" }];
  const prefill: LeadPrefill = {
    leadId: "lead-1", customerId: "c-1", customerName: "Excel Technologies",
    domain: "exceltechnologies.in", contactName: "", contactEmail: "", contactPhone: "",
    plan: "", seats: null, billingChoice: "annual_yearly",
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddSubscriptionDialog open onOpenChange={() => {}} onSuccess={() => {}} prefill={prefill} />
    </QueryClientProvider>,
  );
}
const clearButton = () => Array.from(document.querySelectorAll("button"))
  .find((b) => (b.textContent ?? "").includes("Clear Selection"));

describe("R-818 — editing the domain keeps the picked customer", () => {
  it("customer stays selected and its fields stay filled when the domain changes", async () => {
    mountWithPickedCustomer();
    await waitFor(() => expect(clearButton()).toBeDefined());
    expect(field("custName")?.value).toBe("Excel Technologies");
    expect(field("contactName")).toBeNull();   // existing customer → no contact block

    set("subDomain", "excel-second-domain.in");

    expect(field("subDomain")?.value).toBe("excel-second-domain.in");
    expect(field("custName")?.value).toBe("Excel Technologies");
    expect(clearButton()).toBeDefined();
    expect(field("contactName")).toBeNull();
  });

  it("submitting with the new domain links the picked customer instead of creating one", async () => {
    mountWithPickedCustomer();
    await waitFor(() => expect(clearButton()).toBeDefined());
    set("subDomain", "excel-second-domain.in");
    set("pricePerSeat", "1632");
    set("paymentDueDate", "2026-10-11");
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(writes).toContain("subscriptions"));
    expect(writes).not.toContain("customers");
  });

  it("Clear Selection is still the explicit way to detach", async () => {
    mountWithPickedCustomer();
    await waitFor(() => expect(clearButton()).toBeDefined());
    fireEvent.click(clearButton()!);
    expect(field("custName")?.value).toBe("");
    expect(field("contactName")).not.toBeNull();
  });
});
