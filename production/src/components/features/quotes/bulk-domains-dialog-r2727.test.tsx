// @vitest-environment jsdom
/* R-2727 item 3 (Pratik, staging): after "+ Add domain" the cursor stayed on the button, so the
   next domain typed went nowhere. The new row's domain box gets the focus. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import type { Item } from "@/lib/supabase/database.types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ from: () => ({ select: () => ({ eq: async () => ({ data: [] }) }) }) }),
}));

import { BulkDomainsDialog } from "./bulk-domains-dialog";

const CATALOG = [{ id: "it-in", name: ".in", vendor: "domain", msrp: 1200, wholesale: 600, item_type: "subscription", prices: { billing_unit: "unit_year" } }] as unknown as Item[];

afterEach(cleanup);

describe("R-2727 Bulk dialog — Add domain moves the cursor to the new row", () => {
  it("one click → Domain 2 has focus; a second click → Domain 3", () => {
    render(<BulkDomainsDialog open onOpenChange={() => {}} catalog={CATALOG} customerId="" onAdd={() => {}} />);
    const add = screen.getByRole("button", { name: "Add domain" });
    add.focus();
    fireEvent.click(add);
    expect(document.activeElement).toBe(screen.getByLabelText("Domain 2"));
    fireEvent.click(add);
    expect(document.activeElement).toBe(screen.getByLabelText("Domain 3"));
  });
  it("typing into a row never steals focus back to another row", () => {
    render(<BulkDomainsDialog open onOpenChange={() => {}} catalog={CATALOG} customerId="" onAdd={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    const first = screen.getByLabelText("Domain 1");
    first.focus();
    fireEvent.change(first, { target: { value: "a1.in" } });
    expect(document.activeElement).toBe(first);
  });
});
