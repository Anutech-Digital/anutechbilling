// @vitest-environment jsdom
/**
 * R-1134 (23 Oct 2026) — rows that open or expand on click must be reachable by keyboard
 * (WCAG 2.1.1). Three screens had a mouse-only `onClick` on a `<tr>` / `<li>` / Card:
 *
 *  - /customers/groups/[id]  each company row (desktop table + phone card) opens the company
 *  - /reports/purchases      each vendor / category / month row expands its bills
 *  - /contacts               each phone-list card opens the contact
 *
 * Each now carries a real <a href> or <button> (Tab stops on it; Enter/Space work natively)
 * with a visible focus ring. The row's own click stays for mouse users.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import type { UnifiedContact } from "@/lib/queries/contacts";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useParams: () => ({ id: "g1" }),
}));

// ── /customers/groups/[id] data ──
vi.mock("@/lib/queries/customer-groups", () => ({
  useCustomerGroup: () => ({
    data: { id: "g1", name: "Acme Group", is_partner: false, is_active: true, notes: null, contact_name: null, contact_phone: null },
    isLoading: false, isError: false, refetch: vi.fn(),
  }),
  useDeleteCustomerGroup: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/app/(app)/customers/groups/group-queries", () => ({
  useGroupMembers: () => ({
    data: [{ id: "c1", name: "Beta Pvt Ltd", gstin: null, state: "Punjab" }],
    isError: false,
  }),
  useMembersMrr: () => ({ data: new Map([["c1", 1000]]), isError: false }),
}));
vi.mock("@/lib/queries/payments", () => ({
  useOutstandingReceivables: () => ({ data: [], isError: false }),
}));
vi.mock("@/components/features/customers/group-form-dialog", () => ({ GroupFormDialog: () => null }));

// ── /reports/purchases data ──
vi.mock("@tanstack/react-query", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({
    data: [{ id: "e1", source: "expense", date: "2026-10-05", vendor: "Amazon", category: "Office", net: 100, gst: 18 }],
    isLoading: false, error: null, refetch: vi.fn(),
  }),
}));

// ── /contacts data ──
vi.mock("@/components/features/contacts/import-contacts-dialog", () => ({ default: () => null }));
vi.mock("@/components/features/contacts/contact-form", () => ({ ContactForm: () => null }));
vi.mock("@/components/features/campaigns/campaign-composer-dialog", () => ({ default: () => null }));
const CONTACT: UnifiedContact = {
  id: "imported:p1", source: "imported", refId: "p1", name: "Ravi Kumar", email: "ravi@x.in", phone: "9800000000",
  company: "—", title: null, status: null, createdAt: "2026-10-01T00:00:00Z", business: "none",
  relationshipType: "unknown", closeness: null, relContactId: "p1",
};
vi.mock("@/lib/queries/contacts", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/contacts")>()),
  useAllContacts: () => ({ data: [CONTACT], isLoading: false, error: null, refetch: vi.fn() }),
}));

import GroupPage from "@/app/(app)/customers/groups/[id]/page";
import PurchasesPage from "@/app/(app)/reports/purchases/page";
import ContactsPage from "@/app/(app)/contacts/page";

afterEach(() => { cleanup(); push.mockReset(); });

/** Tab stops on it: a link with an href or an enabled button, not taken out of the tab order. */
function expectTabbable(el: HTMLElement) {
  const tag = el.tagName;
  expect(tag === "A" || tag === "BUTTON", `${tag} is not a native control`).toBe(true);
  if (tag === "A") expect(el.getAttribute("href")).toBeTruthy();
  expect(el.tabIndex).toBeGreaterThanOrEqual(0);
  // A visible focus ring (keyboard focus only).
  expect(el.className).toMatch(/focus-visible:(ring|outline)/);
  el.focus();
  expect(document.activeElement).toBe(el);
}

describe("R-1134 — /customers/groups/[id] company rows", () => {
  it("desktop row: the company name is a link to the company", () => {
    render(<GroupPage />);
    const table = screen.getByRole("table");
    const link = within(table).getByRole("link", { name: "Beta Pvt Ltd" });
    expectTabbable(link);
    expect(link.getAttribute("href")).toBe("/customers/c1");
  });

  it("phone card: the whole card is one link to the company", () => {
    render(<GroupPage />);
    const links = screen.getAllByRole("link", { name: /Beta Pvt Ltd/ });
    const card = links.find((l) => !l.closest("table"));
    expect(card, "phone card link").toBeTruthy();
    expectTabbable(card!);
    expect(card!.getAttribute("href")).toBe("/customers/c1");
  });
});

describe("R-1134 — /reports/purchases breakdown rows", () => {
  it("desktop row: a button expands the bills and says so (aria-expanded)", () => {
    render(<PurchasesPage />);
    const tables = screen.getAllByRole("table");
    const btn = within(tables[0]).getByRole("button", { name: /Amazon/ });
    expectTabbable(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn); // Enter/Space on a native button fire click
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("R-1134 — /contacts phone list", () => {
  it("each card has a button that opens the contact", () => {
    render(<ContactsPage />);
    const list = screen.getAllByRole("list").find((l) => l.className.includes("md:hidden"))!;
    const btn = within(list).getByRole("button", { name: /Ravi Kumar/ });
    expectTabbable(btn);
    fireEvent.click(btn);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/contacts/p1");
  });
});
