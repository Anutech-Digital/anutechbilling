/* R-1713 (billing audit, 20 Oct 2026). A sent quote showed "Out for review" as its badge, sat
   in "Awaiting payment (21)" while "Sent (0)" was empty, and the "Out for review ₹0 (0)" tile
   counted nothing; "Accepted ₹6.2L (18)" sat over an Accepted tab of 3. Q-0016 (billed
   quarterly) said "Annual commitment · billed per year" on its line. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { QUOTE_STATE_LABEL, quoteStateLabel } from "./state-labels";
import { quoteListTab, quoteTabCounts } from "./list-tab";
import { quoteInFocus } from "./focus";
import { unifiedStatus } from "./status-badge";
import { lineScheduleNote } from "./billing";
import type { Quote } from "@/lib/supabase/database.types";

type Row = Pick<Quote, "status" | "payment_status" | "amount" | "payment_amount"> & { invoice_id?: string | null };
const q = (over: Partial<Row>): Row => ({ status: "sent", payment_status: "none", amount: 1180, payment_amount: 0, ...over }) as Row;

describe("R-1713 a sent quote has one name: Sent", () => {
  /* Extension / add-seats / checkout quotes are created with payment_status 'awaiting'. */
  const sentAwaiting = q({ status: "sent", payment_status: "awaiting" });

  it("badge, tab and tile all say Sent", () => {
    expect(unifiedStatus(sentAwaiting).label).toBe(QUOTE_STATE_LABEL.sent);
    expect(quoteListTab(sentAwaiting)).toBe("sent");
    expect(quoteInFocus(sentAwaiting, "review")).toBe(true);
  });

  it("a viewed or draft quote with payment_status 'awaiting' stays in its own tab", () => {
    expect(quoteListTab(q({ status: "viewed", payment_status: "awaiting" }))).toBe("viewed");
    expect(quoteListTab(q({ status: "draft", payment_status: "awaiting" }))).toBe("draft");
  });

  it("an accepted quote waiting for money is still Awaiting payment", () => {
    expect(quoteListTab(q({ status: "accepted", payment_status: "awaiting" }))).toBe("awaiting");
  });

  it("no 'Out for review' anywhere — one word per state", () => {
    expect(Object.values(QUOTE_STATE_LABEL)).not.toContain("Out for review");
    for (const s of ["draft", "sent", "viewed", "rejected"] as const) {
      expect(unifiedStatus(q({ status: s })).label).toBe(QUOTE_STATE_LABEL[s]);
    }
    expect(quoteStateLabel("received")).toBe(unifiedStatus(q({ status: "accepted", payment_status: "received" })).label);
  });
});

describe("R-1713 each tile counts the same quotes as its tab", () => {
  const quotes: Row[] = [
    q({ status: "sent", payment_status: "awaiting" }),
    q({ status: "sent" }),
    q({ status: "viewed" }),
    q({ status: "accepted", payment_status: "awaiting" }),
    q({ status: "accepted", payment_status: "received", payment_amount: 1180 }),
    q({ status: "accepted", payment_status: "invoiced", invoice_id: "INV-1", payment_amount: 1180 }),
    q({ status: "accepted", payment_status: "invoiced", invoice_id: "INV-2", payment_amount: 0 }),
  ];
  const c = quoteTabCounts(quotes);

  it("Sent + viewed tile = Sent tab + Viewed tab", () => {
    expect(quotes.filter((x) => quoteInFocus(x, "review")).length).toBe(c.sent + c.viewed);
    expect(c.sent).toBe(2);
  });

  it("Accepted tile = Accepted tab", () => {
    expect(quotes.filter((x) => quoteInFocus(x, "accepted")).length).toBe(c.accepted);
  });
});

describe("R-1713 the line says the quote's real billing cycle", () => {
  it("quarterly quote, annual line → billed quarterly (Q-0016)", () => {
    expect(lineScheduleNote("annual_yearly", "quarterly")).toBe("Annual commitment · billed quarterly");
    expect(lineScheduleNote("annual_yearly", "yearly")).toBe("Annual commitment · billed yearly");
    expect(lineScheduleNote("annual_yearly", "half_yearly")).toBe("Annual commitment · billed half-yearly");
  });

  it("an old quote with no billing_cycle reads it from the line's legacy commitment", () => {
    expect(lineScheduleNote("annual_quarterly", null)).toBe("Annual commitment · billed quarterly");
    expect(lineScheduleNote("annual_yearly", null)).toBe("Annual commitment · billed yearly");
  });

  it("a flex line is monthly", () => {
    expect(lineScheduleNote("monthly", "monthly")).toBe("Monthly, flexible · billed monthly");
  });

  const root = path.resolve(__dirname, "../../app/(app)/quotes");
  const detail = readFileSync(path.join(root, "[id]/page.tsx"), "utf8");
  const list = readFileSync(path.join(root, "page.tsx"), "utf8");

  it("the quote page no longer hard-codes 'billed per year', and its PDF gets the cycle", () => {
    expect(detail).not.toContain('"Annual commitment · billed per year"');
    expect(detail).toMatch(/billingCycle:\s*quote\.billing_cycle/);
  });

  it("no page hard-codes 'Out for review'", () => {
    expect(list).not.toMatch(/>\s*Out for [Rr]eview/);
    expect(list).not.toMatch(/label: "Awaiting payment"/);
  });
});
