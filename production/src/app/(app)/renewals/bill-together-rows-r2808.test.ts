/* R-2808 — Renewals rows → Bill together groups (shown when a member is on screen) and each row's hint. */
import { describe, it, expect } from "vitest";
import { groupsShown, togetherIndex, togetherRowOf } from "./bill-together-rows";
import type { QueueItem } from "./queue-items";

type Item = Pick<QueueItem, "sub" | "stage" | "docs">;
const item = (id: string, plan: string, o: { key?: string; split?: boolean; partDays?: number | null; inv?: string | null; customer?: string } = {}): Item => ({
  sub: { id, plan, seats: 10, customer_id: o.customer ?? "c-it", customer_name: "ITBUZZ Technologies", domain: " itbuzz.in ",
    billing_cycle: "monthly", renewal_date: "2026-10-01" } as unknown as Item["sub"],
  stage: { key: o.key ?? "part-due", split: o.split ?? true, partDays: o.partDays ?? null } as unknown as Item["stage"],
  docs: { quote: null, invoice: o.inv === null ? null : { id: o.inv ?? "INV-1" } } as unknown as Item["docs"],
});

describe("R-2808 togetherRowOf / togetherIndex", () => {
  it("billable only when a part is to bill NOW: Part not billed, or due inside the 7-day Bill next part window", () => {
    expect(togetherRowOf(item("a", "Business Standard"))).toMatchObject({
      id: "a", customerId: "c-it", split: true, billable: true, domain: "itbuzz.in", lastInvoiceId: "INV-1", nextPartStart: "2026-10-01", billingCycle: "monthly",
    });
    expect(togetherRowOf(item("a", "X", { key: "due", partDays: 5 })).billable).toBe(true);
    expect(togetherRowOf(item("a", "X", { key: "due", partDays: 25 })).billable).toBe(false);   // months / weeks away — not now
    expect(togetherRowOf(item("a", "X", { key: "due", partDays: null })).billable).toBe(false);
    expect(togetherRowOf(item("a", "X", { key: "sent" })).billable).toBe(false);
    expect(togetherRowOf(item("a", "X", { split: false, key: "due", partDays: 1 })).billable).toBe(false);
  });

  it("group + hints + labels; the group shows only when one of its rows is on screen", () => {
    const all = [item("a", "Business Standard"), item("b", "Business Starter"), item("c", "Other", { customer: "c-2" })];
    const idx = togetherIndex(all);
    expect(groupsShown(idx, new Set(["b"])).map((g) => g.subIds)).toEqual([["a", "b"]]);
    expect(idx.hintOf.get("a")?.text).toBe("Bills with Business Starter");
    expect(idx.hintOf.get("b")?.text).toBe("Bills with Business Standard");
    expect(idx.hintOf.has("c")).toBe(false);
    expect(idx.subOf.get("b")).toEqual({ id: "b", plan: "Business Starter", seats: 10 });
    expect(groupsShown(idx, new Set(["c"]))).toEqual([]);
  });
});
