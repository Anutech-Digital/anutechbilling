// @vitest-environment jsdom
/* R-2712 (Pratik, 16 Oct) — "Bulk / many domains" gets a Start date and, for a domain plan,
   "Register for 1–10 years". The line it adds carries start_date + years and the whole term's
   rate; a Workspace plan gets the start date only. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import type { Item, QuoteLineItem } from "@/lib/supabase/database.types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ from: () => ({ select: () => ({ eq: async () => ({ data: [] }) }) }) }),
}));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<typeof import("@/lib/dates/ist")>()), istToday: () => "2026-11-13" }));

import { BulkDomainsDialog } from "./bulk-domains-dialog";

const item = (id: string, name: string, vendor: Item["vendor"], msrp: number, wholesale: number, prices?: unknown) =>
  ({ id, name, vendor, msrp, wholesale, item_type: "subscription", prices: prices ?? null }) as unknown as Item;
/* .in is priced per YEAR (billing_unit unit_year, R-526): ₹1,200 list, ₹600 cost — never × 12.
   Zoho Mail is per seat per MONTH: 200 × 12 = ₹2,400 a year, cost 150 × 12 = ₹1,800. */
const CATALOG = [
  item("it-in", ".in", "domain", 1200, 600, { billing_unit: "unit_year" }),
  item("it-gws", "Zoho Mail Lite", "zoho", 200, 150),
];

function open() {
  const added: QuoteLineItem[] = [];
  render(<BulkDomainsDialog open onOpenChange={() => {}} catalog={CATALOG} customerId="" onAdd={(l) => added.push(l)} />);
  return added;
}
const pick = (id: string) => fireEvent.change(screen.getByLabelText("Plan"), { target: { value: id } });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(cleanup);

describe("R-2712 Bulk dialog — Register for N years + Start date", () => {
  it("domain plan: 3 domains, ₹800 a year, 3 years from 1 Sep 2026 → one line of ₹7,200 with years + start", () => {
    const added = open();
    pick("it-in");
    type("Rate (₹/seat/year)", "800");
    type("Start date", "2026-09-01");
    type("Register for", "3");
    type("Domain 1", "a1.in");
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    type("Domain 2", "a2.in");
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    type("Domain 3", "a3.in");

    const summary = screen.getByTestId("bulk-summary").textContent ?? "";
    expect(summary).toContain("₹7,200");
    expect(summary).toContain("for 3 years, billed once (ex-GST)");
    expect(summary).toContain("Each subscription starts 1 Sep 2026 and renews 1 Sep 2029.");

    fireEvent.click(screen.getByRole("button", { name: "Add bulk line (3)" }));
    expect(added).toHaveLength(1);
    const line = added[0];
    expect([line.qty, line.rate, line.cost, line.years, line.start_date]).toEqual([3, 2400, 1800, 3, "2026-09-01"]);
    expect(line.qty * line.rate).toBe(7200);
    expect(line.bulk).toBe(true);
    expect(line.domains?.map((d) => d.domain)).toEqual(["a1.in", "a2.in", "a3.in"]);
  });

  it("defaults: start = today, 1 year → the line is the old 1-year line plus today's start date", () => {
    const added = open();
    pick("it-in");
    expect((screen.getByLabelText("Start date") as HTMLInputElement).value).toBe("2026-11-13");
    expect((screen.getByLabelText("Register for") as HTMLSelectElement).value).toBe("1");
    type("Domain 1", "a1.in");
    expect(screen.getByTestId("bulk-summary").textContent).toContain("/yr (ex-GST)");
    expect(screen.getByTestId("bulk-summary").textContent).toContain("starts 13 Nov 2026 and renews 13 Nov 2027");
    fireEvent.click(screen.getByRole("button", { name: "Add bulk line (1)" }));
    /* A per-year item comes in at its yearly price and cost — it was × 12 (₹14,400 / ₹7,200). */
    expect((screen.getByLabelText("Rate (₹/seat/year)") as HTMLInputElement).value).toBe("1200");
    expect([added[0].rate, added[0].cost, added[0].years, added[0].start_date]).toEqual([1200, 600, undefined, "2026-11-13"]);
  });

  it("a seat plan (Zoho Mail) has no years picker — and years picked earlier for a domain plan do not carry over", () => {
    const added = open();
    pick("it-in");
    type("Register for", "5");
    pick("it-gws");
    expect(screen.queryByLabelText("Register for")).toBeNull();
    expect(screen.getByLabelText("Start date")).toBeTruthy();
    type("Domain 1", "acme.in");
    fireEvent.click(screen.getByRole("button", { name: "Add bulk line (1)" }));
    expect([added[0].rate, added[0].cost, added[0].years, added[0].start_date]).toEqual([2400, 1800, undefined, "2026-11-13"]);
  });

  it("start date cleared → refused with 'Pick a start date.' — never quietly today", () => {
    const added = open();
    pick("it-in");
    type("Start date", "2026-09-01");
    type("Start date", "");
    type("Domain 1", "a1.in");
    expect(screen.getByTestId("bulk-summary").textContent).toContain("Pick a start date.");
    expect(screen.getByTestId("bulk-summary").textContent).not.toContain("renews");
    const add = screen.getByRole("button", { name: "Add bulk line (1)" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(added).toHaveLength(0);
    type("Start date", "2026-09-01");
    expect(add.disabled).toBe(false);
  });

  it("a past start is allowed; a renewal date already past shows a plain warning and still adds", () => {
    const added = open();
    pick("it-in");
    type("Domain 1", "a1.in");
    /* Back-dated, renewal still ahead (1 Sep 2026 + 1 year): no warning. */
    type("Start date", "2026-09-01");
    expect(screen.queryByTestId("bulk-renewal-past")).toBeNull();
    /* 1 Apr 2024 + 2 years = 1 Apr 2026, before today (13 Nov 2026): warning. */
    type("Start date", "2024-04-01");
    type("Register for", "2");
    expect(screen.getByTestId("bulk-renewal-past").textContent)
      .toBe("Renewal date 1 Apr 2026 is already past — each subscription will be due for renewal as soon as it is created.");
    /* 3 years → 1 Apr 2027: ahead again, the warning goes. */
    type("Register for", "3");
    expect(screen.queryByTestId("bulk-renewal-past")).toBeNull();
    type("Register for", "2");
    fireEvent.click(screen.getByRole("button", { name: "Add bulk line (1)" }));
    expect([added[0].start_date, added[0].years]).toEqual(["2024-04-01", 2]);
  });
});
