/**
 * R-813 — an add-seats quote's notes: a plain line for the customer, the audit for staff.
 *
 * Staging, 10 Oct 2026: Q-5F40-27-0012's customer link showed the subscription UUID,
 * "backdated by Pardeep Sharma" and "factor 99.7260%". This calls the real addSeats()
 * against a fake client and checks both halves of what it stores.
 */
import { describe, it, expect } from "vitest";
import { addSeats, type AddSeatsInput } from "./add-seats";
import { customerQuoteNotes, staffQuoteNotes } from "@/lib/quotes/customer-notes";

const SUB = "c28000ac-1b2c-4d5e-8f90-123456789abc";

function fakeSupabase(quotes: Record<string, unknown>[]) {
  const table = (name: string) => ({
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    insert: (row: Record<string, unknown>) => {
      if (name === "quotes") quotes.push(row);
      return Promise.resolve({ error: null });
    },
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
  });
  return {
    from: (name: string) => table(name),
    rpc: () => Promise.resolve({ data: "Q-TEST-0001", error: null }),
  } as unknown as AddSeatsInput["supabase"];
}

async function stored(over: Partial<AddSeatsInput> = {}) {
  const quotes: Record<string, unknown>[] = [];
  const r = await addSeats({
    supabase: fakeSupabase(quotes),
    subscriptionId: SUB, tenantId: "t-1", customerId: "c-1", customerName: "HOK Agrichem",
    plan: "Google Workspace Business Starter", vendor: "google", domain: "hok.in",
    currentSeats: 10, currentMrr: 2700, additionalSeats: 2,
    renewalDate: "2027-03-31", graceDays: 7, taxRatePct: 18, termDays: 365,
    todayISO: "2026-10-10",
    ...over,
  });
  expect(r.ok).toBe(true);
  return { notes: String(quotes[0].notes), lines: quotes[0].line_items as { name: string }[] };
}

describe("addSeats — R-813 notes", () => {
  it("backdated: the customer reads only the period; no UUID, no staff name, no factor", async () => {
    const { notes, lines } = await stored({ effectiveDate: "2026-09-25", effectiveDateSetBy: "Pardeep Sharma" });
    const customer = customerQuoteNotes(notes, lines);
    expect(customer).toBe("Additional seats from 25 Sep 2026 to 31 Mar 2027 (pro-rata).");
    expect(customer).not.toContain(SUB);
    expect(customer).not.toMatch(/backdated by/i);
    expect(customer).not.toMatch(/factor/i);
  });

  it("staff still have the whole audit", async () => {
    const { notes } = await stored({ effectiveDate: "2026-09-25", effectiveDateSetBy: "Pardeep Sharma" });
    const staff = staffQuoteNotes(notes);
    expect(staff).toContain(`Add-seats pro-rata for subscription ${SUB}`);
    expect(staff).toContain("Effective date 2026-09-25 (backdated by Pardeep Sharma on 2026-10-10)");
    expect(staff).toMatch(/\(factor \d+\.\d{4}%\)/);
  });

  it("a split-billed charge names the instalment end, not renewal", async () => {
    const { notes, lines } = await stored({ chargeWindow: { remainingDays: 83, chargeTo: "2026-12-31" } });
    expect(customerQuoteNotes(notes, lines)).toBe("Additional seats from 10 Oct 2026 to 31 Dec 2026 (pro-rata).");
  });
});
