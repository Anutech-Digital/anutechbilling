/**
 * R-2411 — a promise to pay or an open dispute HOLDS the automatic payment reminders.
 *   • promise: the newest promise's date is today or later → hold until that date (they still
 *     have the day); the day after, with the money not in, reminders resume (the promise is
 *     broken and the list flags it — promiseStatus).
 *   • dispute: the newest dispute entry is "disputed" (not followed by "dispute_resolved") →
 *     hold until someone resolves it. A dispute wins over a promise.
 * Plus the server loader the dunning cron uses (tenant-scoped, one read).
 */
import { describe, it, expect } from "vitest";
import {
  collectionHold, holdLabel, isOnHold, openDispute, stageFor,
  DISPUTED, DISPUTE_RESOLVED, type HoldRow,
} from "./followup-rules";
import { loadCollectionHolds, holdKey } from "./collection-hold.server";
import { fakePostgrest } from "@/lib/ops/fake-postgrest.testutil";
import { formatDate } from "@/lib/utils";

const row = (id: string, created_at: string, extra: Partial<HoldRow> = {}): HoldRow => ({
  id, created_at, kind: "call", note: null, outcome: null, promised_on: null, promised_amount: null, ...extra,
});

describe("collectionHold", () => {
  it("no entries → no hold", () => {
    expect(collectionHold([], "2026-11-03")).toBeNull();
    expect(isOnHold([], "2026-11-03")).toBe(false);
  });

  it("a promise dated later → held until that date; on the date itself still held", () => {
    const rows = [row("p", "2026-11-01T05:00:00Z", { kind: "promise", promised_on: "2026-11-06", promised_amount: 5000 })];
    expect(collectionHold(rows, "2026-11-03")).toEqual({ kind: "promise", until: "2026-11-06", amount: 5000 });
    expect(isOnHold(rows, "2026-11-06")).toBe(true);
  });

  it("the day after the promise date → no hold (reminders resume; the list shows it broken)", () => {
    const rows = [row("p", "2026-11-01T05:00:00Z", { kind: "promise", promised_on: "2026-11-06" })];
    expect(collectionHold(rows, "2026-11-07")).toBeNull();
  });

  it("only the NEWEST promise counts — a later, earlier-dated promise replaces the old one", () => {
    const rows = [
      row("old", "2026-11-01T05:00:00Z", { kind: "promise", promised_on: "2026-11-20" }),
      row("new", "2026-11-02T05:00:00Z", { kind: "promise", promised_on: "2026-11-04" }),
    ];
    expect(collectionHold(rows, "2026-11-05")).toBeNull();
  });

  it("an open dispute holds with its reason, and wins over a promise", () => {
    const rows = [
      row("p", "2026-11-01T05:00:00Z", { kind: "promise", promised_on: "2026-11-20" }),
      row("d", "2026-11-02T05:00:00Z", { outcome: DISPUTED, note: "Says 2 licences were never used" }),
    ];
    expect(collectionHold(rows, "2026-11-03")).toEqual({
      kind: "dispute", since: "2026-11-02", reason: "Says 2 licences were never used", entryId: "d",
    });
    expect(openDispute(rows)).toMatchObject({ entryId: "d" });
  });

  it("a resolved dispute no longer holds; a new dispute after it does", () => {
    const resolved = [
      row("d", "2026-11-02T05:00:00Z", { outcome: DISPUTED, note: "Wrong rate" }),
      row("r", "2026-11-03T05:00:00Z", { kind: "note", outcome: DISPUTE_RESOLVED, note: "Dispute resolved." }),
    ];
    expect(collectionHold(resolved, "2026-11-04")).toBeNull();
    const again = [...resolved, row("d2", "2026-11-05T05:00:00Z", { outcome: DISPUTED, note: "Again" })];
    expect(collectionHold(again, "2026-11-06")).toMatchObject({ kind: "dispute", entryId: "d2" });
  });

  it("other outcomes (renewal_confirmed) and plain calls never hold", () => {
    const rows = [row("c", "2026-11-02T05:00:00Z", { outcome: "renewal_confirmed" }), row("x", "2026-11-03T05:00:00Z")];
    expect(collectionHold(rows, "2026-11-03")).toBeNull();
  });
});

describe("labels and stage (for the list — R-2408 / R-2409 can use them)", () => {
  it("holdLabel says what is paused and until when", () => {
    expect(holdLabel({ kind: "promise", until: "2026-11-06", amount: null })).toBe(`Promised · ${formatDate("2026-11-06")} — reminders paused`);
    expect(holdLabel({ kind: "dispute", since: "2026-11-02", reason: "x", entryId: "d" })).toBe("Disputed — reminders paused");
  });

  it("stageFor: disputed > promised > broken > null", () => {
    const dispute = { kind: "dispute" as const, since: "2026-11-02", reason: null, entryId: "d" };
    const promise = { kind: "promise" as const, until: "2026-11-06", amount: null };
    expect(stageFor({ hold: dispute, promiseBroken: true })).toBe("disputed");
    expect(stageFor({ hold: promise, promiseBroken: false })).toBe("promised");
    expect(stageFor({ hold: null, promiseBroken: true })).toBe("broken");
    expect(stageFor({ hold: null, promiseBroken: false })).toBeNull();
  });
});

describe("loadCollectionHolds (server, used by the dunning cron)", () => {
  const seed = () => ({
    payment_followups: [
      { id: "p1", tenant_id: "T1", customer_id: "C1", kind: "promise", note: null, outcome: null, promised_on: "2026-11-10", promised_amount: null, created_at: "2026-11-01T05:00:00Z" },
      { id: "d1", tenant_id: "T1", customer_id: "C2", kind: "call", note: "Wrong GST", outcome: DISPUTED, promised_on: null, promised_amount: null, created_at: "2026-11-01T05:00:00Z" },
      { id: "c1", tenant_id: "T1", customer_id: "C3", kind: "call", note: "Called", outcome: null, promised_on: null, promised_amount: null, created_at: "2026-11-01T05:00:00Z" },
      /* another company's row for the same customer id must never hold this company's invoice */
      { id: "x1", tenant_id: "T2", customer_id: "C3", kind: "call", note: "Other co", outcome: DISPUTED, promised_on: null, promised_amount: null, created_at: "2026-11-01T05:00:00Z" },
    ],
  });

  it("one map keyed by tenant + customer; plain calls and other tenants' rows hold nothing", async () => {
    const db = fakePostgrest(seed());
    const holds = await loadCollectionHolds(db.client as never, [{ tenantId: "T1", customerId: "C1" }, { tenantId: "T1", customerId: "C2" }, { tenantId: "T1", customerId: "C3" }], "2026-11-03");
    expect(holds.get(holdKey("T1", "C1"))).toEqual({ kind: "promise", until: "2026-11-10", amount: null });
    expect(holds.get(holdKey("T1", "C2"))).toMatchObject({ kind: "dispute", reason: "Wrong GST" });
    expect(holds.has(holdKey("T1", "C3"))).toBe(false);
  });

  it("no customers → no read, empty map", async () => {
    const holds = await loadCollectionHolds(fakePostgrest({}).client as never, [], "2026-11-03");
    expect(holds.size).toBe(0);
  });
});
