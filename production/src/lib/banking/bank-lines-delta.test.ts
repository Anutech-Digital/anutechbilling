/**
 * R-2524 — a refetch after a save reads only the changed bank lines (lib/banking/bank-lines-delta).
 * The merged list must equal a full read; anything doubtful (count differs, no full read yet,
 * too long since the last one) falls back to reading everything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { byLedgerReadOrder, deltaSince, mergeDelta, readBankLines, resetDeltaState, DELTA_MARGIN_MS, FULL_EVERY_MS, type DeltaLine } from "./bank-lines-delta";

type L = DeltaLine & { matched_to_type: string | null };
const line = (n: number, date: string, upd = "2026-11-06T09:00:00Z", m: string | null = null): L =>
  ({ id: `id-${String(n).padStart(4, "0")}`, txn_date: date, updated_at: upd, matched_to_type: m });

/** 6,000 lines in the full read's order. */
const account = () => Array.from({ length: 6000 }, (_, i) => line(i, `2026-${String(1 + (i % 12)).padStart(2, "0")}-15`)).sort(byLedgerReadOrder);

beforeEach(() => resetDeltaState());

describe("R-2524 mergeDelta", () => {
  it("one reconciled line: same order, that line replaced, every other line the SAME object", () => {
    const prev = account();
    const saved = { ...prev[17], matched_to_type: "payment", updated_at: "2026-11-06T10:00:00Z" };
    const out = mergeDelta(prev, [saved], 6000)!;
    expect(out).toHaveLength(6000);
    expect(out[17]).toBe(saved);
    expect(out.filter((l, i) => l !== prev[i])).toEqual([saved]);
  });

  it("new lines (an import) join in ledger order", () => {
    const prev = account();
    const added = [line(9001, "2026-12-31"), line(9002, "2026-01-01")];
    const out = mergeDelta(prev, added, 6002)!;
    expect(out).toEqual([...prev, ...added].sort(byLedgerReadOrder));
    expect(out[0]).toBe(added[0]);
  });

  it("a deleted line (count lower than held) → null, the caller reads everything", () => {
    expect(mergeDelta(account(), [], 5999)).toBeNull();
    expect(mergeDelta(account(), [line(9001, "2026-05-05")], 6000)).toBeNull();
  });

  it("nothing changed and the count agrees → the very same list", () => {
    const prev = account();
    expect(mergeDelta(prev, [], 6000)).toBe(prev);
  });
});

describe("R-2524 deltaSince", () => {
  it("newest updated_at minus the margin; none → null", () => {
    expect(deltaSince([line(1, "2026-01-01", "2026-11-06T09:00:00Z"), line(2, "2026-01-02", "2026-11-06T10:00:00.123456+00:00")]))
      .toBe(new Date(Date.parse("2026-11-06T10:00:00.123Z") - DELTA_MARGIN_MS).toISOString());
    expect(deltaSince([])).toBeNull();
  });
});

describe("R-2524 readBankLines", () => {
  const io = (rows: L[], changed: L[] = [], count = rows.length) => ({
    full: vi.fn(async () => rows),
    changedSince: vi.fn(async () => changed),
    count: vi.fn(async () => count),
  });

  it("first load is a full read; the next refetch reads only the changes", async () => {
    const rows = account();
    const first = io(rows);
    const t0 = Date.now();
    expect(await readBankLines("acc", undefined, first, t0)).toBe(rows);
    expect(first.full).toHaveBeenCalledTimes(1);

    const saved = { ...rows[3], matched_to_type: "expense", updated_at: "2026-11-06T11:00:00Z" };
    const second = io(rows, [saved], 6000);
    const out = await readBankLines("acc", rows, second, t0 + 1000);
    expect(second.full).not.toHaveBeenCalled();
    expect(second.changedSince).toHaveBeenCalledTimes(1);
    expect(out[3]).toBe(saved);
  });

  it("count mismatch → full read; long since the last full read → full read", async () => {
    const rows = account();
    const t0 = Date.now();
    await readBankLines("acc", undefined, io(rows), t0);
    const mismatch = io(rows.slice(1), [], 5999);
    expect(await readBankLines("acc", rows, mismatch, t0 + 1000)).toHaveLength(5999);
    expect(mismatch.full).toHaveBeenCalledTimes(1);

    const stale = io(rows);
    await readBankLines("acc", rows, stale, Date.now() + FULL_EVERY_MS + 1);
    expect(stale.full).toHaveBeenCalledTimes(1);
    expect(stale.changedSince).not.toHaveBeenCalled();
  });

  it("a cache held from before this session (no full read recorded) is never trusted", async () => {
    const rows = account();
    const fresh = io(rows);
    await readBankLines("other", rows, fresh, Date.now());
    expect(fresh.full).toHaveBeenCalledTimes(1);
  });
});
