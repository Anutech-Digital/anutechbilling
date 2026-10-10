import { describe, expect, it } from "vitest";
import { buildCustomerActivity } from "./customer-insights";
import type { Invoice, Quote, Subscription } from "@/lib/supabase/database.types";

// R-532 (10 Oct 2026): quote, invoice paid and subscription all on 7 Oct showed subscription first.
const day = "2026-10-07";
const sub = { start_date: day, plan: "Google Workspace Business Starter", domain: null, seats: 10 } as unknown as Subscription;
const quote = { id: "Q-1", created_date: day, status: "accepted", plan: "Google Workspace Business Starter" } as unknown as Quote;
const paid = { id: "INV-1", paid_date: day, invoice_date: day, amount: 38232, status: "paid" } as unknown as Invoice;
const older = { id: "Q-0", created_date: "2026-10-01", status: "sent", plan: null } as unknown as Quote;

describe("R-532: customer activity order", () => {
  it("same-day events: newest stage first (subscription, paid, quote)", () => {
    const titles = buildCustomerActivity([sub], [paid], [quote]).map((e) => e.title);
    expect(titles).toEqual(["Subscription started", "Invoice INV-1 paid", "Quote Q-1 accepted"]);
  });

  it("a later day still beats an earlier one, whatever the stage", () => {
    const titles = buildCustomerActivity([sub], [], [older, quote]).map((e) => e.title);
    expect(titles).toEqual(["Subscription started", "Quote Q-1 accepted", "Quote Q-0 sent"]);
  });
});
