/**
 * R-814 — an add-seats quote stays open for the normal quote validity, capped at the last
 * day it charges for. Staging, 10 Oct 2026: Q-5F40-27-0012 said "Valid until 7 Oct 2027 /
 * Quote validity: 362 days".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addSeats, type AddSeatsInput } from "./add-seats";
import { DEFAULT_QUOTE_VALIDITY_DAYS, addSeatsQuoteExpiry } from "@/lib/quotes/quote-validity";

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

async function expiry(over: Partial<AddSeatsInput>): Promise<unknown> {
  const quotes: Record<string, unknown>[] = [];
  const r = await addSeats({
    supabase: fakeSupabase(quotes),
    subscriptionId: "sub-1", tenantId: "t-1", customerId: "c-1", customerName: "HOK Agrichem",
    plan: "Google Workspace Business Starter", vendor: "google", domain: "hok.in",
    currentSeats: 10, currentMrr: 2700, additionalSeats: 2,
    renewalDate: "2027-10-07", graceDays: 7, taxRatePct: 18, termDays: 365,
    todayISO: "2026-10-10",
    ...over,
  });
  expect(r.ok).toBe(true);
  return quotes[0].expires_date;
}

describe("addSeatsQuoteExpiry", () => {
  it("normal validity from today", () => {
    expect(addSeatsQuoteExpiry("2026-10-10", "2027-10-07")).toBe("2026-11-09");
  });
  it("capped at the last charged day", () => {
    expect(addSeatsQuoteExpiry("2026-10-10", "2026-10-25")).toBe("2026-10-25");
    expect(addSeatsQuoteExpiry("2026-10-10", "2026-10-25T00:00:00Z")).toBe("2026-10-25");
  });
  it("never before today", () => {
    expect(addSeatsQuoteExpiry("2026-10-10", "2026-10-01")).toBe("2026-10-10");
  });
});

describe("addSeats — R-814 expiry", () => {
  it("Q-5F40-27-0012's shape: renewal a year out → 30 days, not 362", async () => {
    expect(await expiry({})).toBe("2026-11-09");
  });
  it("backdating does not stretch it — validity runs from today", async () => {
    expect(await expiry({ effectiveDate: "2026-09-25" })).toBe("2026-11-09");
  });
  it("term ends in 10 days → valid to the term end", async () => {
    expect(await expiry({ renewalDate: "2026-10-20" })).toBe("2026-10-20");
  });
  it("split billing → capped at the instalment end it charges to", async () => {
    expect(await expiry({ chargeWindow: { remainingDays: 21, chargeTo: "2026-10-31" } })).toBe("2026-10-31");
  });
});

/* Normal quotes are unchanged: the builder still defaults to the same 30 days. If someone
   changes that default, this keeps add-seats quotes on the same rule. */
describe("the default matches the quote builder", () => {
  it("quote-builder starts 'Valid for (days)' at DEFAULT_QUOTE_VALIDITY_DAYS", () => {
    const src = readFileSync(join(__dirname, "..", "..", "components/features/quotes/quote-builder.tsx"), "utf8");
    expect(src).toContain(`const [validityDays, setValidityDays] = React.useState(${DEFAULT_QUOTE_VALIDITY_DAYS});`);
  });
});
