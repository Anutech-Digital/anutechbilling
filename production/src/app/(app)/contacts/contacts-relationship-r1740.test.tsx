// @vitest-environment jsdom
/**
 * R-1740 — the owner's path on /contacts (card examples 4 and 5, plus "count people only"
 * and the Map), on the real page with the contact book mocked.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import type { UnifiedContact } from "@/lib/queries/contacts";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("@tanstack/react-query", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/features/contacts/import-contacts-dialog", () => ({ default: () => null }));
vi.mock("@/components/features/contacts/contact-form", () => ({ ContactForm: () => null }));
vi.mock("@/components/features/campaigns/campaign-composer-dialog", () => ({ default: () => null }));

const T = "2026-10-01T00:00:00Z";
let n = 0;
const p = (o: Partial<UnifiedContact>): UnifiedContact => {
  n++;
  return {
    id: `imported:p${n}`, source: "imported", refId: `p${n}`, name: `Person ${n}`, email: `p${n}@x.in`, phone: null,
    company: "—", title: null, status: null, createdAt: T, business: "none", relationshipType: "unknown", closeness: null,
    relContactId: `p${n}`, ...o,
  };
};

const BOOK: UnifiedContact[] = [
  // Customers: 3 friends, 4 unknown.
  ...[1, 2, 3].map((i) => p({ name: `Cust Friend ${i}`, business: "customer", relationshipType: "friend" })),
  ...[1, 2, 3, 4].map((i) => p({ name: `Cust Unknown ${i}`, business: "customer" })),
  // Leads: Rahul = Friend · Close, one more friend, a cold lead.
  p({ name: "Rahul", source: "lead", id: "lead:L1", refId: "L1", business: "lead", relationshipType: "friend", closeness: "close" }),
  p({ name: "Second Friend Lead", source: "lead", id: "lead:L2", refId: "L2", business: "lead", relationshipType: "friend" }),
  p({ name: "Cold Lead", source: "lead", id: "lead:L3", refId: "L3", business: "lead" }),
  // An old partner contact (mapped by the migration) — Partner · Professional.
  p({ name: "Old Partner", relationshipType: "partner" }),
  // Two companies with nobody on them.
  p({ name: "Empty Co", source: "customer", id: "customer:c1", refId: "c1", isCompany: true, email: null, title: null, business: "customer" }),
  p({ name: "Blank Ltd", source: "customer", id: "customer:c2", refId: "c2", isCompany: true, email: null, title: null, business: "customer" }),
];

vi.mock("@/lib/queries/contacts", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/contacts")>()),
  useAllContacts: () => ({ data: BOOK, isLoading: false, error: null, refetch: vi.fn() }),
}));

import ContactsPage from "./page";

beforeEach(() => { window.history.replaceState(null, "", "/contacts"); });
afterEach(() => { cleanup(); push.mockReset(); });

const pill = (name: RegExp) => screen.getByRole("button", { name });

describe("/contacts — Business × Relationship (R-1740)", () => {
  it("counts people only; companies without a contact person are shown apart", () => {
    render(<ContactsPage />);
    expect(pill(/^Business: All, 11 people$/)).toBeTruthy();
    expect(screen.getByText(/Showing 11 of 11 people/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /2 companies without a contact person — add one/ })).toBeTruthy();
  });

  it("Business = Customer → the Relationship row reads Friend 3, Relative 0, Unknown 4", () => {
    render(<ContactsPage />);
    fireEvent.click(pill(/^Business: Customer, 7 people$/));
    expect(pill(/^Relationship: Friend, 3 people$/)).toBeTruthy();
    expect(pill(/^Relationship: Relative, 0 people$/)).toBeTruthy();
    expect(pill(/^Relationship: Unknown, 4 people$/)).toBeTruthy();
    expect(window.location.search).toBe("?biz=customer");
  });

  it("grid cell Friend × Lead (2) → just those 2 people, URL ?biz=lead&rel=friend", () => {
    render(<ContactsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Friend × Lead: 2 people" }));
    expect(window.location.search).toBe("?biz=lead&rel=friend");
    expect(screen.getByText(/Showing 2 of 11 people/)).toBeTruthy();
    const rows = screen.getAllByRole("button", { name: /^Open / }).filter((el) => el.tagName === "TR");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Open Rahul", "Open Second Friend Lead"]);
  });

  it("a shared link ?biz=lead&rel=friend opens on those 2 people", () => {
    window.history.replaceState(null, "", "/contacts?biz=lead&rel=friend");
    render(<ContactsPage />);
    expect(screen.getByText(/Showing 2 of 11 people/)).toBeTruthy();
  });

  it("chips: Rahul 'Friend · Close', cold lead 'Unknown', old partner 'Partner · Professional'", () => {
    render(<ContactsPage />);
    const row = (name: string) => screen.getAllByRole("button", { name: `Open ${name}` }).find((el) => el.tagName === "TR")!;
    expect(within(row("Rahul")).getByText("Friend · Close")).toBeTruthy();
    expect(within(row("Cold Lead")).getByText("Unknown")).toBeTruthy();
    expect(within(row("Old Partner")).getByText("Partner · Professional")).toBeTruthy();
  });

  it("Map: Rahul sits on the inner ring, the cold lead on the outer; click opens the lead", () => {
    window.history.replaceState(null, "", "/contacts?view=map");
    render(<ContactsPage />);
    expect(screen.getAllByText("Close · 1").length).toBeGreaterThan(0);   // SVG ring label + phone list heading
    expect(screen.getAllByText("Unknown · 5").length).toBeGreaterThan(0);        // 4 customers + the cold lead
    expect(screen.getAllByText("Weak or not set · 5").length).toBeGreaterThan(0); // friends with no closeness + old partner
    const dot = screen.getAllByRole("button", { name: "Rahul — Friend · Close. Open" })[0];
    fireEvent.click(dot);
    expect(push).toHaveBeenCalledWith("/leads?lead=L1");
  });

  it("the companies-without-a-person link lists exactly those companies", () => {
    render(<ContactsPage />);
    fireEvent.click(screen.getByRole("button", { name: /2 companies without a contact person/ }));
    expect(window.location.search).toBe("?missing=1");
    expect(screen.getByText("2 companies")).toBeTruthy();
    const rows = screen.getAllByRole("button", { name: /^Open / }).filter((el) => el.tagName === "TR");
    expect(rows.map((r) => r.getAttribute("aria-label")).sort()).toEqual(["Open Blank Ltd", "Open Empty Co"]);
  });
});
