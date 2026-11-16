/* R-2849 — a YEARLY Renewals row is "billable" for Bill together when its renewal is due (no renewal quote made yet,
   not even a draft) inside its first reminder window; two such rows of one customer on last year's invoice → one
   renewal group (kind "renewal"), never mixed with a split row. */
import { describe, it, expect } from "vitest";
import { togetherIndex, togetherRowOf, YEARLY_TOGETHER_LEAD_DAYS } from "./bill-together-rows";
import { firstReminderDaysOut } from "@/lib/renewals/cadence";
import type { QueueItem } from "./queue-items";

type Item = Pick<QueueItem, "sub" | "stage" | "docs">;
const item = (id: string, plan: string, o: { key?: string; split?: boolean; days?: number | null; quoteId?: string | null; inv?: string | null; term?: number } = {}): Item => ({
  sub: { id, plan, seats: 20, customer_id: "c-it", customer_name: "ITBUZZ Technologies", domain: "itbuzz.in",
    billing_cycle: o.split ? "monthly" : "yearly", term_months: o.term ?? 12, renewal_date: "2026-10-31" } as unknown as Item["sub"],
  stage: { key: o.key ?? "due", split: o.split ?? false, renewalDays: o.days === undefined ? 10 : o.days, quoteId: o.quoteId ?? null, partDays: o.split ? 3 : null } as unknown as Item["stage"],
  docs: { quote: null, invoice: o.inv === null ? null : { id: o.inv ?? "INV-25-1" } } as unknown as Item["docs"],
});

describe("R-2849 yearly rows", () => {
  /* 30 days BEFORE the first reminder (when the cron makes each one its own renewal quote) */
  const window = firstReminderDaysOut(12) + YEARLY_TOGETHER_LEAD_DAYS;

  it("billable: one-year, due, no renewal quote yet, from 30 days before the first reminder (or past the date)", () => {
    expect(togetherRowOf(item("a", "Business Standard")).billable).toBe(true);
    expect(togetherRowOf(item("a", "X", { days: -5 })).billable).toBe(true);
    expect(togetherRowOf(item("a", "X", { days: window })).billable).toBe(true);
    expect(togetherRowOf(item("a", "X", { days: window + 1 })).billable).toBe(false);
    expect(togetherRowOf(item("a", "X", { quoteId: "Q-1" })).billable).toBe(false);   // a draft / sent renewal quote already
    expect(togetherRowOf(item("a", "X", { key: "sent" })).billable).toBe(false);
    expect(togetherRowOf(item("a", "X", { key: "renewed" })).billable).toBe(false);
    expect(togetherRowOf(item("a", "X", { days: null })).billable).toBe(false);
    expect(togetherRowOf(item("a", "X", { term: 36 })).billable).toBe(false);   // a 3-year term never goes on a together quote
  });

  it("two yearly rows on last year's invoice → one renewal group; a split row on the same invoice stays out", () => {
    const idx = togetherIndex([item("a", "Business Standard"), item("b", "Business Starter"), item("c", "Vault", { split: true, key: "part-due" })]);
    expect(idx.groups).toEqual([{ customerId: "c-it", customerName: "ITBUZZ Technologies", subIds: ["a", "b"], why: "same-bill", kind: "renewal" }]);
    expect(idx.hintOf.get("a")?.text).toBe("Bills with Business Starter");
    expect(idx.hintOf.has("c")).toBe(false);
  });
});

describe("R-2849 H1 rows", () => {
  it("a yearly domain / hosting row is never billable (never suggested with a Workspace row on the same domain)", () => {
    for (const vendor of ["domain", "hosting"]) {
      const it0 = item("d", "example.in");
      (it0.sub as unknown as { vendor: string }).vendor = vendor;
      expect(togetherRowOf(it0).billable).toBe(false);
      expect(togetherIndex([item("a", "Business Standard", { inv: null }), it0]).groups).toEqual([]);
    }
  });
});
