/**
 * Co-terming, pinned — added seats renew WITH the parent, never on their own clock.
 *
 * ─── WHY A TEST AND NOT A CODE REVIEW ───────────────────────────────────────
 * add-seats.ts is co-termed by construction: it prorates to the subscription's EXISTING
 * `renewal_date` and its update payload carries only `seats` and `mrr`. I verified that by
 * reading it, which is a perfectly good answer to "does it work" and no answer at all to
 * "will it still work next month". Nothing failed if somebody added `renewal_date` to that
 * update — and rolling the date forward on a seat top-up is a plausible-looking change,
 * because it is what a RENEWAL does.
 *
 * The cost of getting it wrong is not visible on screen: the parent subscription's renewal
 * quietly moves, the customer gets months they did not pay for, and the renewal chase fires
 * late. So this calls the real function against a fake client and asserts what it WRITES.
 *
 * ─── AND THE SAME TEST PINS THE MONEY UNIT ──────────────────────────────────
 * proration.ts works in integer paise on purpose (one rounding, no drift). The boundary
 * back to whole rupees is a single `paiseToRupees()` call, and if it were ever dropped the
 * quote would persist ₹1,18,360 as 11836000 — a hundredfold overcharge that looks like a
 * plausible number. Asserting the persisted values are whole rupees catches that.
 */
import { describe, it, expect } from "vitest";
import { addSeats, type AddSeatsInput } from "./add-seats";

/* ── A fake Supabase that records every write ──────────────────────────────── */

interface Captured {
  quotes: Record<string, unknown>[];
  purchaseOrders: Record<string, unknown>[];
  subUpdates: Record<string, unknown>[];
}

function fakeSupabase(captured: Captured) {
  const table = (name: string) => ({
    select: () => ({
      /* loadCatalog does .select().eq() — an empty catalogue is fine here: the cost then
         falls back to the heuristic, which this test does not assert on. */
      eq: () => Promise.resolve({ data: [], error: null }),
    }),
    insert: (row: Record<string, unknown>) => {
      if (name === "quotes")           captured.quotes.push(row);
      if (name === "purchase_orders")  captured.purchaseOrders.push(row);
      return Promise.resolve({ error: null });
    },
    update: (patch: Record<string, unknown>) => ({
      eq: () => {
        if (name === "subscriptions") captured.subUpdates.push(patch);
        return Promise.resolve({ error: null });
      },
    }),
  });

  return {
    from: (name: string) => table(name),
    rpc: (fn: string) => {
      if (fn === "next_document_number") return Promise.resolve({ data: "Q-TEST-0001", error: null });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as AddSeatsInput["supabase"];
}

/** A real-shaped call: 25 seats of Workspace Standard at ₹30,240/mo, +10 mid-term. */
function input(over: Partial<AddSeatsInput> = {}): { in: AddSeatsInput; captured: Captured } {
  const captured: Captured = { quotes: [], purchaseOrders: [], subUpdates: [] };
  return {
    captured,
    in: {
      supabase: fakeSupabase(captured),
      subscriptionId: "sub-1",
      tenantId: "tenant-1",
      customerId: "cust-1",
      customerName: "AB corprotion",
      plan: "Google Workspace Standard",
      vendor: "google",
      domain: "abc.com",
      currentSeats: 25,
      currentMrr: 30240,
      additionalSeats: 10,
      /* Deliberately far out so the term has not ended — the pro-rata factor is not what
         this file is about. */
      renewalDate: futureISO(200),
      graceDays: 7,
      taxRatePct: 18,
      termDays: 365,
      ...over,
    },
  };
}

function futureISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("adding seats does not move the renewal date", () => {
  it("updates ONLY seats and mrr on the subscription", async () => {
    const { in: args, captured } = input();
    const r = await addSeats(args);
    expect(r.ok).toBe(true);

    expect(captured.subUpdates).toHaveLength(1);
    /* The whole point. An exact key set, not a `toMatchObject` — a partial match would
       pass happily while a renewal_date sat alongside. */
    expect(Object.keys(captured.subUpdates[0]).sort()).toEqual(["mrr", "seats"]);
  });

  it("never writes renewal_date, start_date or status", async () => {
    const { in: args, captured } = input();
    await addSeats(args);
    const patch = captured.subUpdates[0];
    for (const forbidden of ["renewal_date", "start_date", "status", "quote_id"]) {
      expect(patch, `add-seats must not touch ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });

  it("carries the seats forward rather than replacing them", async () => {
    const { in: args, captured } = input();
    await addSeats(args);
    expect(captured.subUpdates[0].seats).toBe(35);   // 25 + 10, not 10
  });

  /**
   * R-814: the pro-rata quote expires after the normal 30-day validity, never past the
   * PARENT's renewal — it used to run to renewal + grace (362 days on Q-5F40-27-0012), so a
   * customer could accept a pro-rata price long after the days it charged for had gone.
   */
  it("expires the pro-rata quote after the normal validity, capped at the parent's renewal", async () => {
    const { in: args, captured } = input({ renewalDate: "2027-03-31", graceDays: 7, todayISO: "2026-10-10" });
    await addSeats(args);
    expect(captured.quotes[0].expires_date).toBe("2026-11-09");

    const near = input({ renewalDate: "2026-10-20", graceDays: 7, todayISO: "2026-10-10" });
    await addSeats(near.in);
    expect(near.captured.quotes[0].expires_date).toBe("2026-10-20");
  });

  it("marks the quote as an add-seats top-up, so record_payment makes no second subscription", async () => {
    /* is_add_seats is what stops the payment flow creating a duplicate subscription
       (migration 0052). Without it, paying this quote would double the customer's MRR. */
    const { in: args, captured } = input();
    await addSeats(args);
    expect(captured.quotes[0].is_add_seats).toBe(true);
    expect(captured.quotes[0].is_renewal).toBe(false);
  });
});

describe("what is persisted is whole rupees", () => {
  it("stores integers, never paise", async () => {
    const { in: args, captured } = input();
    await addSeats(args);
    const q = captured.quotes[0];

    for (const field of ["amount", "subtotal", "total_cost"] as const) {
      const v = q[field];
      expect(typeof v, field).toBe("number");
      expect(Number.isInteger(v), `${field} must be a whole rupee, got ${String(v)}`).toBe(true);
    }
  });

  it("keeps the amount in a sane rupee range — a paise leak would be ~100× too big", async () => {
    /* 10 seats of a ₹14,515/seat/year plan, part-year, plus 18% GST. Anything near a
       hundred times that is proration.ts's internal paise escaping to the database. */
    const { in: args, captured } = input();
    const r = await addSeats(args);
    expect(r.ok && r.amount).toBeGreaterThan(0);
    expect(r.ok && r.amount).toBeLessThan(200_000);
    expect(captured.quotes[0].amount).toBe(r.ok && r.amount);
  });

  it("carries the customer's OWN tax rate, so a zero-rated export stays zero", async () => {
    /* This was a hardcoded × 1.18 once, and it billed ₹2,135 of GST on an export that
       must carry none. */
    const { in: args, captured } = input({ taxRatePct: 0 });
    await addSeats(args);
    expect(captured.quotes[0].tax_rate).toBe(0);
    expect(captured.quotes[0].amount).toBe(captured.quotes[0].subtotal);
  });
});

describe("it refuses rather than guessing", () => {
  it("will not add seats to a subscription with no renewal date", async () => {
    /* There is nothing to co-term TO. Inventing one would start a second clock. */
    const { in: args, captured } = input({ renewalDate: "" });
    const r = await addSeats(args);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("no_renewal_date");
    expect(captured.subUpdates).toHaveLength(0);
  });

  it("will not add seats after the term has ended", async () => {
    const { in: args, captured } = input({ renewalDate: "2020-01-01" });
    const r = await addSeats(args);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("term_ended");
    expect(captured.quotes).toHaveLength(0);
  });

  it("refuses a zero or negative seat count", async () => {
    for (const n of [0, -5]) {
      const { in: args } = input({ additionalSeats: n });
      const r = await addSeats(args);
      expect(r.ok, `additionalSeats ${n}`).toBe(false);
    }
  });
});

