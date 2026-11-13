/* R-2764 (R-2742 PERF-1): the queue's rows are built by one pure function (queue-items.ts) so the page
   can memoise them; and a tab shows 50 rows, then "Show N more". */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildQueueItems, firstRows, QUEUE_PAGE_ROWS } from "./queue-items";
import type { Subscription } from "@/lib/supabase/database.types";

const sub = (id: string, renewal_date: string, extra: Partial<Subscription> = {}): Subscription => ({
  id, customer_id: `c-${id}`, customer_name: `Customer ${id}`, plan: "Business Starter", vendor: "google", seats: 5, used: 5,
  mrr: 1000, status: "active", renewal_date, term_months: 12, auto_renew: true, billing_cycle: "yearly",
  renewal_quote_id: null, outstanding_amount: 0, start_date: "2025-11-01", quote_id: null, renewal_state: null,
  ...extra,
} as unknown as Subscription);

const TODAY = "2026-11-14";
const base = {
  openRenewalMap: new Map<string, string>(), quoteInfo: new Map(), quoteStatusMap: new Map<string, string>(),
  docs: undefined, docsLoading: false, fuData: undefined, contacts: undefined, role: "owner", graceDays: 0,
  today: new Date(`${TODAY}T12:00:00+05:30`), todayIst: TODAY,
};

describe("R-2764 buildQueueItems", () => {
  it("puts each row on exactly one tab, with its amount and status", () => {
    const b = buildQueueItems({ ...base, subs: [sub("a", "2026-11-10"), sub("b", "2026-11-18"), sub("c", "2027-06-01")] });
    expect(b.allItems.map((i) => i.sub.id).sort()).toEqual(["a", "b", "c"]);
    expect(b.items.overdue.map((i) => i.sub.id)).toEqual(["a"]);
    expect(b.items.due7.map((i) => i.sub.id)).toEqual(["b"]);
    expect(b.items.later.map((i) => i.sub.id)).toEqual(["c"]);
    expect(b.items.overdue[0].daysUntil).toBe(-4);
    expect(b.items.due7[0].amount.value).toBeGreaterThan(0);
  });

  it("documents still loading → no stage (never a guess)", () => {
    const b = buildQueueItems({ ...base, docsLoading: true, subs: [sub("a", "2026-11-18")] });
    expect(b.allItems[0].stage).toBeNull();
  });
});

describe("R-2764 firstRows", () => {
  it("50 rows, then the rest behind Show more", () => {
    const rows = Array.from({ length: 62 }, (_, i) => i);
    expect(firstRows(rows, QUEUE_PAGE_ROWS)).toEqual({ shown: rows.slice(0, 50), more: 12 });
    expect(firstRows(rows.slice(0, 50), QUEUE_PAGE_ROWS).more).toBe(0);
  });
});

describe("R-2764 page wiring (the freeze must not come back)", () => {
  const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
  it("rows are built in a useMemo, not on every render", () => {
    expect(src).toMatch(/React\.useMemo\(\(\) => \(subs \? buildQueueItems\(/);
    expect(src).not.toMatch(/tabs\[t\]\.map\(toItem\)/);
  });
  it("only ONE layout is mounted (no CSS-hidden second copy)", () => {
    expect(src).not.toMatch(/min-\[1260px\]:hidden/);
    expect(src).not.toMatch(/hidden min-\[1260px\]:block/);
    expect(src).toMatch(/\{!table && \(/);
    expect(src).toMatch(/\{table && \(/);
  });
  it("row buttons get the viewer from the queue (lazy per-row hooks)", () => {
    expect(src.match(/viewer=\{viewer\}/g)?.length).toBe(2);
  });
});

/* R-2761: an open 'held' renewal undo (held-data.ts) reaches the row's stage as the "Renewal held" flag, and the
   page rebuilds the rows when the holds load (holds in the useMemo deps). */
describe("R-2761 buildQueueItems — Renewal held flag", () => {
  const held = sub("h", "2027-09-30", { status: "expired", billing_cycle: "quarterly", renewal_state: "renewed" } as Partial<Subscription>);
  it("an open hold on the row's renewal date → renewalHeld flag on its stage", () => {
    const holds = new Map([["h", { kind: "not_active" as const, from: "2027-09-30", to: "2026-09-30" }]]);
    const row = buildQueueItems({ ...base, subs: [held], holds }).allItems[0];
    expect(row.stage?.flags.map((x) => x.key)).toContain("renewalHeld");
    expect(row.stage?.flags.find((x) => x.key === "renewalHeld")?.reason).toMatch(/^Renewal held — subscription expired/);
  });
  it("no holds read yet → no flag", () => {
    const row = buildQueueItems({ ...base, subs: [held] }).allItems[0];
    expect(row.stage?.flags.map((x) => x.key)).not.toContain("renewalHeld");
  });
  it("page passes holds into buildQueueItems and its useMemo deps", () => {
    const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(src).toMatch(/useRenewalHolds\(listed\.map\(\(s\) => s\.id\)\)/);
    expect(src).toMatch(/todayIst: todayIst, holds,\n\s*\}\) : null\), \[[^\]]*\bholds\]\);/);
  });
});
