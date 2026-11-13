/**
 * R-2661 — the per-company, per-IST-day Zoho call meter: counts every call, refuses the call past the
 * budget BEFORE it is made, Zoho's own "per day" 429 marks the day, a new IST day starts at 0, a sink
 * that fails never breaks a call (memory still counts), the token registry, the budget from env.
 * Pure — a memory sink; Zoho is never called. Names and numbers are made up.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createDayMeter, dayMeterOf, forgetDayMeters, isZohoDayLimitRefusal, istDayOf, registerDayMeter,
  zohoDayBudget, zohoDayCallsLabel, ZOHO_DAY_BUDGET_DEFAULT, type DayCallsRow, type DayCallsSink,
} from "./zoho-day-budget";
import { isZohoDayLimit, listPage, ZohoApiError, ZohoDayLimitError } from "./api";
import { isZohoBusy, runPaced } from "./fy-fetch";

/** A memory sink for ONE tenant, with a hook to fail writes. */
function memorySink(seed: DayCallsRow[] = []) {
  const rows = new Map(seed.map((r) => [r.day, { ...r }]));
  const s = {
    reads: 0, adds: 0, failAdd: false, failRead: false,
    /** Another app instance added calls behind this meter's back. */
    other(day: string, n: number) { const r = rows.get(day) ?? { day, calls: 0, limitHitAt: null }; r.calls += n; rows.set(day, r); },
    sink: {
      async read(day) { s.reads++; if (s.failRead) throw new Error("db down"); const r = rows.get(day); return r ? { ...r } : null; },
      async add(day, calls, refusal) {
        s.adds++;
        if (s.failAdd) throw new Error("db down");
        const r = rows.get(day) ?? { day, calls: 0, limitHitAt: null };
        r.calls += calls;
        if (refusal && !r.limitHitAt) r.limitHitAt = "2026-11-13T04:24:00.000Z";
        rows.set(day, r);
        return { ...r };
      },
    } satisfies DayCallsSink,
    rows,
  };
  return s;
}

/* 13 Nov 2026 10:00 UTC = 15:30 IST. */
const T = Date.parse("2026-11-13T10:00:00Z");

describe("R-2661 Zoho day budget — meter", () => {
  beforeEach(() => forgetDayMeters());

  it("counts every call on the IST day and refuses the one past the budget BEFORE it is made", async () => {
    const m = memorySink();
    const meter = createDayMeter("t1", m.sink, { budget: 3, log: () => {} });
    expect(await meter.check(T)).toBeNull();
    await meter.note(T, null); await meter.note(T + 1000, null);
    expect(await meter.remaining(T + 2000)).toBe(1);
    expect(await meter.check(T + 2000)).toBeNull();
    await meter.note(T + 2000, null);
    const stop = await meter.check(T + 3000);
    expect(stop).toMatchObject({ day: "2026-11-13", calls: 3, budget: 3, spent: true, limitHitAt: null });
    /* The next IST midnight: 14 Nov 00:00 IST = 13 Nov 18:30 UTC. */
    expect(new Date(stop!.retryAt).toISOString()).toBe("2026-11-13T18:30:00.000Z");
    expect(await meter.remaining(T + 3000)).toBe(0);
    expect(m.rows.get("2026-11-13")).toMatchObject({ calls: 3 });
    expect(m.adds).toBe(3);
  });

  it("a call at 19:00Z counts on the NEXT IST date; the new day starts at 0 again", async () => {
    expect(istDayOf(Date.parse("2026-11-13T19:00:00Z"))).toBe("2026-11-14");
    expect(istDayOf(Date.parse("2026-11-13T18:29:59Z"))).toBe("2026-11-13");
    const m = memorySink();
    const meter = createDayMeter("t1", m.sink, { budget: 2, log: () => {} });
    await meter.note(T, null); await meter.note(T, null);
    expect(await meter.check(T)).not.toBeNull();
    const next = Date.parse("2026-11-13T19:00:00Z");
    expect(await meter.check(next)).toBeNull();
    expect(await meter.state(next)).toMatchObject({ day: "2026-11-14", calls: 0, spent: false });
    await meter.note(next, null);
    expect(m.rows.get("2026-11-14")).toMatchObject({ calls: 1 });
    expect(m.rows.get("2026-11-13")).toMatchObject({ calls: 2 });
  });

  it("Zoho's own per-day 429 exhausts the day even when our count is low; a per-minute 429 stays busy only", async () => {
    expect(isZohoDayLimitRefusal(429, "You have exceeded the API request limit for the day")).toBe(true);
    expect(isZohoDayLimitRefusal(429, "Daily API limit exceeded")).toBe(true);
    expect(isZohoDayLimitRefusal(429, "too many requests")).toBe(false);
    expect(isZohoDayLimitRefusal(429, "Rate limit exceeded: 100 requests per minute")).toBe(false);
    expect(isZohoDayLimitRefusal(500, "day")).toBe(false);
    const m = memorySink();
    const meter = createDayMeter("t1", m.sink, { budget: 900, log: () => {} });
    await meter.note(T, { status: 429, message: "too many requests" });
    expect(await meter.check(T)).toBeNull();
    await meter.note(T, { status: 429, message: "API request limit for the day exceeded" });
    const stop = await meter.check(T);
    expect(stop).toMatchObject({ calls: 2, spent: true });
    expect(stop!.limitHitAt).toBeTruthy();
    expect(m.rows.get("2026-11-13")!.limitHitAt).toBeTruthy();
  });

  it("takes the RPC's total: calls another app instance made are seen after our next call", async () => {
    const m = memorySink();
    const meter = createDayMeter("t1", m.sink, { budget: 10, log: () => {} });
    await meter.note(T, null);
    m.other("2026-11-13", 5);
    expect((await meter.state(T)).calls).toBe(1);   /* not yet seen (no read between calls) */
    await meter.note(T, null);
    expect((await meter.state(T)).calls).toBe(7);
  });

  it("a sink that fails never breaks the call and the memory count still goes up (conservative)", async () => {
    const m = memorySink();
    const logs: string[] = [];
    const meter = createDayMeter("t1", m.sink, { budget: 2, log: (x) => logs.push(x) });
    m.failAdd = true;
    await meter.note(T, null); await meter.note(T, null);
    expect(await meter.check(T)).toMatchObject({ calls: 2, spent: true });
    expect(logs.length).toBe(2);
    expect(m.rows.get("2026-11-13")).toBeUndefined();
    /* A read that fails = a fresh day in memory (never a crash). */
    const m2 = memorySink([{ day: "2026-11-13", calls: 800, limitHitAt: null }]);
    m2.failRead = true;
    const meter2 = createDayMeter("t1", m2.sink, { budget: 900, log: () => {} });
    expect(await meter2.check(T)).toBeNull();
  });

  it("reads a stored day once: the row from the database is the starting count", async () => {
    const m = memorySink([{ day: "2026-11-13", calls: 899, limitHitAt: null }]);
    const meter = createDayMeter("t1", m.sink, { budget: 900, log: () => {} });
    expect(await meter.remaining(T)).toBe(1);
    await meter.note(T, null);
    expect(await meter.check(T)).toMatchObject({ calls: 900, spent: true });
    expect(m.reads).toBe(1);
    /* A day Zoho already refused on is spent from the first check. */
    const m2 = memorySink([{ day: "2026-11-13", calls: 12, limitHitAt: "2026-11-13T04:24:00Z" }]);
    const meter2 = createDayMeter("t1", m2.sink, { budget: 900, log: () => {} });
    expect(await meter2.check(T)).toMatchObject({ calls: 12, spent: true, limitHitAt: "2026-11-13T04:24:00Z" });
  });

  it("token registry: a registered token finds its tenant's meter; an unknown token is a no-op; bounded", () => {
    const m = memorySink();
    const a = createDayMeter("t1", m.sink, { budget: 1 });
    registerDayMeter("tok-a", a);
    expect(dayMeterOf("tok-a")).toBe(a);
    expect(dayMeterOf("tok-unknown")).toBeNull();
    expect(dayMeterOf("")).toBeNull();
    for (let i = 0; i < 600; i++) registerDayMeter(`tok-${i}`, a);
    expect(dayMeterOf("tok-a")).toBeNull();          /* the oldest went */
    expect(dayMeterOf("tok-599")).toBe(a);
    registerDayMeter("", a);
    expect(dayMeterOf("")).toBeNull();
  });

  it("api.ts booksGet: a registered token's calls are counted; past the budget the call is refused BEFORE fetch; Zoho's per-day 429 marks the day; an unregistered token is untouched", async () => {
    const urls: string[] = [];
    let answer: () => Response = () => new Response(JSON.stringify({ code: 0, invoices: [], page_context: { has_more_page: false } }), { status: 200 });
    const f = (async (input: string) => { urls.push(String(input)); return answer(); }) as unknown as typeof fetch;
    const m = memorySink();
    const meter = createDayMeter("t1", m.sink, { budget: 2, log: () => {} });
    registerDayMeter("tok-metered", meter);
    await listPage("/invoices", "invoices", "600", "tok-metered", 1, f);
    await listPage("/invoices", "invoices", "600", "tok-metered", 2, f);
    expect(urls).toHaveLength(2);
    expect(m.rows.get(istDayOf(Date.now()))).toMatchObject({ calls: 2 });
    let err: unknown;
    try { await listPage("/invoices", "invoices", "600", "tok-metered", 3, f); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ZohoDayLimitError);
    expect(isZohoDayLimit(err)).toBe(true);
    expect((err as ZohoApiError).code).toBe("day_limit");
    expect((err as ZohoApiError).message).toContain("Zoho calls today: 2 of 2");
    expect(urls).toHaveLength(2);                       /* the third was never made */
    /* Not Zoho's "busy": the paced loop lets it through (stop at once), never a minute's retry. */
    expect(isZohoBusy(err)).toBe(false);
    await expect(runPaced({ step: async () => { await listPage("/invoices", "invoices", "600", "tok-metered", 3, f); return true; }, sleep: async () => {} })).rejects.toBeInstanceOf(ZohoDayLimitError);
    expect(urls).toHaveLength(2);
    /* An unregistered token: no count, no check. */
    await listPage("/invoices", "invoices", "600", "tok-other", 1, f);
    expect(urls).toHaveLength(3);
    expect(m.rows.get(istDayOf(Date.now()))).toMatchObject({ calls: 2 });
    /* Zoho's own per-day 429 (counted, and the day is marked) — even on a fresh meter with a big budget. */
    const m2 = memorySink();
    registerDayMeter("tok-big", createDayMeter("t2", m2.sink, { budget: 900, log: () => {} }));
    answer = () => new Response(JSON.stringify({ code: 44, message: "You have exceeded the API request limit for the day" }), { status: 429 });
    await expect(listPage("/invoices", "invoices", "600", "tok-big", 1, f)).rejects.toMatchObject({ status: 429 });
    expect(m2.rows.get(istDayOf(Date.now()))).toMatchObject({ calls: 1 });
    expect(m2.rows.get(istDayOf(Date.now()))!.limitHitAt).toBeTruthy();
    await expect(listPage("/invoices", "invoices", "600", "tok-big", 1, f)).rejects.toBeInstanceOf(ZohoDayLimitError);
  });

  it("budget from env: whole number ≥ 1 wins; unset / garbage / 0 / negative → the default 900", () => {
    expect(ZOHO_DAY_BUDGET_DEFAULT).toBe(900);
    expect(zohoDayBudget("2500")).toBe(2500);
    expect(zohoDayBudget(" 1 ")).toBe(1);
    expect(zohoDayBudget(undefined)).toBe(900);
    expect(zohoDayBudget("")).toBe(900);
    expect(zohoDayBudget("lots")).toBe(900);
    expect(zohoDayBudget("0")).toBe(900);
    expect(zohoDayBudget("-5")).toBe(900);
    expect(zohoDayBudget("12.5")).toBe(900);
    expect(zohoDayCallsLabel({ calls: 1234, budget: 2500 })).toBe("Zoho calls today: 1,234 of 2,500");
  });
});
