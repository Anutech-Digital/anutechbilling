/**
 * R-2607 — the FY read runs on the server (cron zoho-fy-read + the open dialog), not in a browser
 * tab: lease (one pass at a time), resume after a dead pass, Zoho busy / 429, token refused mid-run,
 * not connected, empty year, DB hiccup, tenant isolation. Zoho is a fake fetch (never the real one);
 * the stores are memory. Names and numbers are made up.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { runBackgroundRead, LEASE_EXTRA_MS, RECONNECT_MESSAGE, STUCK_MS, type BgState, type BgStore, type ZohoAccess } from "./background-read";
import type { ScanRun, ScanStore, ListedRow, ScanFacts } from "./scan";
import { zohoReceiptFacts } from "../receipts-import/normalise";
import { createDayMeter, forgetDayMeters, registerDayMeter, type DayCallsRow } from "../zoho-day-budget";

type Facts = ScanFacts;

function memoryScan() {
  const runs = new Map<string, ScanRun>();
  const rows = new Map<string, ListedRow & { fy: string; payload: Facts | null }>();
  const store: ScanStore<Facts> = {
    async readRun(fy) { return runs.get(fy) ?? null; },
    async saveRun(fy, r) { runs.set(fy, { ...r }); },
    async addListed(fy, list) { for (const x of list) { const p = rows.get(x.zohoId); rows.set(x.zohoId, { ...x, fy, payload: p?.payload ?? null }); } },
    async pendingDetails(fy, limit) { return [...rows.values()].filter((r) => r.fy === fy && !r.payload).map((r) => r.zohoId).slice(0, limit); },
    async saveDetail(_fy, id, f) { rows.get(id)!.payload = f; },
    async drop(_fy, id) { rows.delete(id); },
    async counts(fy) { const a = [...rows.values()].filter((r) => r.fy === fy); return { listed: a.length, detailed: a.filter((r) => r.payload).length }; },
    async reset(fy) { runs.delete(fy); for (const [k, v] of rows) if (v.fy === fy) rows.delete(k); },
    /* R-2653: Read again (keeps the rows) + the re-check after a complete list — not used by these tests. */
    async refresh(fy) { runs.set(fy, { nextPage: 1, listDone: false, listStartedAt: null, onlyAccount: null }); },
    async requeueUnlisted() { return 0; },
  };
  return { store, runs, rows };
}

function memoryBg(requested = true) {
  const s: BgState = { requestedAt: requested ? "2026-11-08T10:00:00Z" : null, leaseUntil: null, error: null, finishedAt: null, lastStepAt: null };
  const bg: BgStore = {
    async request() { s.requestedAt = "2026-11-08T10:00:00Z"; s.error = null; s.finishedAt = null; },
    async readBg() { return { ...s }; },
    async takeLease(_fy, until, now) {
      if (s.leaseUntil && Date.parse(s.leaseUntil) >= now) return false;
      s.leaseUntil = new Date(until).toISOString(); return true;
    },
    async touch(_fy, step) {
      if (s.leaseUntil !== new Date(step.fromMs).toISOString()) return false; /* not our lease any more */
      s.lastStepAt = new Date(step.nowMs).toISOString(); s.pace = step.pace; s.leaseUntil = new Date(step.toMs).toISOString();
      return true;
    },
    async release(_fy, end) {
      if (s.leaseUntil !== new Date(end.leaseUntilMs).toISOString()) return; /* not our lease any more */
      s.leaseUntil = null; s.error = end.error; s.pace = end.pace;
      if (end.finished) { s.requestedAt = null; s.finishedAt = new Date(end.nowMs).toISOString(); }
    },
  };
  return { bg, s };
}

const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** Fake Zoho: `n` customer payments over pages of `per`. `fail(callNo, url)` may return a Response to send instead. */
function fakeZoho(n: number, per = 3, fail?: (call: number, u: URL) => Response | null) {
  let call = 0;
  const tokens: string[] = [];
  const orgs: string[] = [];
  const f = (async (input: string, init?: RequestInit) => {
    call += 1;
    const u = new URL(input);
    tokens.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? (init?.headers as Record<string, string> | undefined)?.authorization ?? ""));
    orgs.push(u.searchParams.get("organization_id") ?? "");
    const bad = fail?.(call, u);
    if (bad) return bad;
    const path = u.pathname.replace("/books/v3/", "");
    if (path.startsWith("customerpayments/")) {
      const id = path.split("/")[1];
      const i = Number(id.replace("p-", ""));
      return j({ code: 0, payment: {
        payment_id: id, payment_number: `PAY-${i}`, date: "2025-06-01", customer_id: "c1", customer_name: "Test Buyer",
        amount: 1000, unused_amount: 0, account_id: "za", account_name: "Bank", payment_mode: "banktransfer", reference_number: "",
        invoices: [{ invoice_id: "inv-1", invoice_number: "INV-1", amount_applied: 1000, tax_amount_withheld: 0 }],
      } });
    }
    const page = Number(u.searchParams.get("page") ?? 1);
    const start = (page - 1) * per;
    const list = Array.from({ length: Math.max(0, Math.min(per, n - start)) }, (_, k) => {
      const i = start + k + 1;
      return { payment_id: `p-${i}`, payment_number: `PAY-${i}`, date: "2025-06-01", amount: 1000 };
    });
    return j({ code: 0, customerpayments: list, page_context: { page, has_more_page: start + per < n } });
  }) as unknown as typeof fetch;
  return { f, calls: () => call, tokens, orgs };
}

/** A clock that moves 100 ms per Zoho call / read of `now` and never really sleeps. */
function clock(start = Date.parse("2026-11-08T10:00:00Z")) {
  let t = start;
  return { now: () => (t += 100), sleep: async (ms: number) => { t += ms; }, set: (v: number) => { t = v; }, get: () => t };
}

const access = (orgId = "org-1", tokens: string[] = ["tok-1"]): { a: () => Promise<ZohoAccess>; dropped: () => number } => {
  let i = 0, dropped = 0;
  return { a: async () => ({ orgId, token: async () => tokens[Math.min(i, tokens.length - 1)], dropToken: async () => { dropped++; i++; } }), dropped: () => dropped };
};

const deps = (over: Partial<Parameters<typeof runBackgroundRead<Facts>>[0]> = {}) => {
  const scan = memoryScan();
  const b = memoryBg();
  const c = clock();
  const z = fakeZoho(7);
  return {
    scan, b, c, z,
    d: { store: scan.store, bg: b.bg, kind: "customerpayments" as const, toFacts: zohoReceiptFacts, fy: "2025-26",
      access: access().a, budgetMs: 600_000, now: c.now, sleep: c.sleep, fetch: z.f, log: () => {}, ...over },
  };
};

describe("R-2607 background FY read", () => {
  it("reads the whole year on the server in one pass, then the request ends (complete)", async () => {
    const { d, b, scan } = deps();
    const r = await runBackgroundRead(d);
    expect(r).toMatchObject({ outcome: "complete", listed: 7, detailed: 7, error: null });
    expect(b.s.requestedAt).toBeNull();
    expect(b.s.finishedAt).not.toBeNull();
    expect(b.s.leaseUntil).toBeNull();
    expect([...scan.rows.values()].every((x) => x.payload)).toBe(true);
  });

  it("nothing asked for → reads nothing (cron with no request)", async () => {
    const scan = memoryScan(); const b = memoryBg(false); const z = fakeZoho(7);
    const r = await runBackgroundRead({ ...deps().d, store: scan.store, bg: b.bg, fetch: z.f });
    expect(r.outcome).toBe("not-requested");
    expect(z.calls()).toBe(0);
  });

  it("second pass without lease does nothing (cron tick + open dialog at once)", async () => {
    const { d, b, z } = deps();
    b.s.leaseUntil = new Date(Date.parse("2026-11-08T10:05:00Z")).toISOString();
    const r = await runBackgroundRead(d);
    expect(r.outcome).toBe("locked");
    expect(z.calls()).toBe(0);
    expect(b.s.leaseUntil).not.toBeNull(); /* the other pass's lease is untouched */
  });

  it("resumes from stored progress after a dead pass (its lease ran out)", async () => {
    const z = fakeZoho(40);
    const { d, b, c, scan } = deps({ budgetMs: 1_500, fetch: z.f });
    const first = await runBackgroundRead(d); /* time runs out part way */
    expect(first.outcome).toBe("time");
    expect(first.detailed).toBeLessThan(40);
    expect(b.s.requestedAt).not.toBeNull();
    const before = z.calls();
    /* a pass that crashed: lease still set, but in the past by the time the next tick comes */
    b.s.leaseUntil = new Date(c.get() + 1_000).toISOString();
    c.set(c.get() + 1_000 + LEASE_EXTRA_MS);
    const second = await runBackgroundRead({ ...d, budgetMs: 600_000 });
    expect(second).toMatchObject({ outcome: "complete", listed: 40, detailed: 40 });
    /* carried on: no page listed twice from the start */
    expect(z.calls()).toBe(40 + 14); /* 14 list pages + 40 details — nothing read twice */
    expect(before).toBeGreaterThan(0);
    expect(scan.runs.get("2025-26")?.listDone).toBe(true);
  });

  it("busy stops the pass and keeps the request (Zoho 429)", async () => {
    const z = fakeZoho(7, 3, (n) => (n === 3 ? j({ code: 44, message: "Too many requests" }, 429) : null));
    const { d, b } = deps({ fetch: z.f });
    const r = await runBackgroundRead(d);
    expect(r.outcome).toBe("busy");
    expect(b.s.requestedAt).not.toBeNull();
    expect(b.s.leaseUntil).toBeNull();
    const again = await runBackgroundRead(d);
    expect(again.outcome).toBe("complete");
  });

  it("401 once retries with a fresh token; twice in a row stops with the reconnect message", async () => {
    const once = fakeZoho(4, 3, (n) => (n === 2 ? j({ code: 57, message: "You are not authorized" }, 401) : null));
    const acc = access("org-1", ["old", "fresh"]);
    const r = await runBackgroundRead(deps({ fetch: once.f, access: acc.a }).d);
    expect(r.outcome).toBe("complete");
    expect(acc.dropped()).toBe(1);

    const always = fakeZoho(4, 3, (n) => (n >= 2 ? j({ code: 57, message: "You are not authorized" }, 401) : null));
    const x = deps({ fetch: always.f });
    const r2 = await runBackgroundRead(x.d);
    expect(r2.outcome).toBe("stopped");
    expect(r2.error).toBe(RECONNECT_MESSAGE);
    expect(x.b.s.requestedAt).toBeNull(); /* no endless loop: the owner must reconnect */
  });

  it("not connected stops with the reason (no Zoho call)", async () => {
    const z = fakeZoho(7);
    const { d, b } = deps({ fetch: z.f, access: async () => ({ error: "Zoho Books is not connected." }) });
    const r = await runBackgroundRead(d);
    expect(r).toMatchObject({ outcome: "stopped", error: "Zoho Books is not connected." });
    expect(z.calls()).toBe(0);
    expect(b.s.requestedAt).toBeNull();
    expect(b.s.error).toBe("Zoho Books is not connected.");
  });

  it("empty year completes with 0", async () => {
    const z = fakeZoho(0);
    const r = await runBackgroundRead(deps({ fetch: z.f }).d);
    expect(r).toMatchObject({ outcome: "complete", listed: 0, detailed: 0 });
  });

  it("db error keeps the request (the next pass carries on)", async () => {
    const x = deps();
    const broken = { ...x.scan.store, saveDetail: async () => { throw new Error("Could not save the Zoho read."); } };
    const r = await runBackgroundRead({ ...x.d, store: broken });
    expect(r.outcome).toBe("retry");
    expect(x.b.s.requestedAt).not.toBeNull();
    expect(x.b.s.leaseUntil).toBeNull();
    expect(x.b.s.error).toMatch(/carries on by itself/);
  });

  it("each tenant uses its own connection (org + token) and its own scan", async () => {
    const z = fakeZoho(2);
    const a = deps({ fetch: z.f, access: access("org-A", ["tok-A"]).a });
    await runBackgroundRead(a.d);
    const b = deps({ fetch: z.f, access: access("org-B", ["tok-B"]).a });
    await runBackgroundRead(b.d);
    const n = z.orgs.length;
    expect(new Set(z.orgs.slice(0, n / 2))).toEqual(new Set(["org-A"]));
    expect(new Set(z.orgs.slice(n / 2))).toEqual(new Set(["org-B"]));
    expect(a.scan.rows).not.toBe(b.scan.rows);
  });
});

describe("R-2607 lease handover", () => {
  it("a slow pass whose lease ran out and was taken over writes nothing on release", async () => {
    const x = deps();
    let hijack = true;
    const store = { ...x.scan.store, saveDetail: async (fy: string, id: string, f: ScanFacts) => {
      if (hijack) { hijack = false; x.b.s.leaseUntil = "2026-11-08T11:00:00.000Z"; } /* another pass took over */
      return x.scan.store.saveDetail(fy, id, f);
    } };
    await runBackgroundRead({ ...x.d, store });
    expect(x.b.s.leaseUntil).toBe("2026-11-08T11:00:00.000Z");
    expect(x.b.s.requestedAt).not.toBeNull();
  });
});

describe("R-2607 review fixes", () => {
  it("Zoho down (503) or a network failure keeps the request (retried next minute), never stops the read", async () => {
    const z = fakeZoho(7, 3, (n) => (n === 2 ? j({ code: 5, message: "Service unavailable" }, 503) : null));
    const x = deps({ fetch: z.f });
    const r = await runBackgroundRead(x.d);
    expect(r.outcome).toBe("retry");
    expect(x.b.s.requestedAt).not.toBeNull();
    expect((await runBackgroundRead(x.d)).outcome).toBe("complete");
  });

  it("a read stuck on the same server error for 30 minutes stops with the reason (no endless silent loop); the error is logged", async () => {
    const x = deps();
    const logs: string[] = [];
    x.b.s.lastStepAt = new Date(x.c.get() - STUCK_MS - 60_000).toISOString();
    const broken = { ...x.scan.store, saveDetail: async () => { throw new Error("value too long for type character varying(60)"); } };
    const r = await runBackgroundRead({ ...x.d, store: broken, log: (m) => logs.push(m) });
    expect(r.outcome).toBe("stopped");
    expect(r.error).toMatch(/no progress for 30 minutes \(value too long/);
    expect(x.b.s.requestedAt).toBeNull();
    expect(logs.join("\n")).toMatch(/value too long/);
  });

  it("Zoho's pace holds across passes: after a 429 the next pass waits out a full minute before calling Zoho", async () => {
    const z = fakeZoho(7, 3, (n) => (n === 2 ? j({ code: 44, message: "Too many requests" }, 429) : null));
    const x = deps({ fetch: z.f });
    expect((await runBackgroundRead(x.d)).outcome).toBe("busy");
    expect((x.b.s.pace ?? []).reduce((s, p) => s + p.calls, 0)).toBeGreaterThanOrEqual(80);
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); await x.c.sleep(ms); };
    expect((await runBackgroundRead({ ...x.d, sleep })).outcome).toBe("complete");
    expect(Math.max(...waits)).toBeGreaterThan(50_000);
  });

  it("a pass saves the last minute's calls with the run, so the dialog's next pass does not start a fresh 80", async () => {
    const x = deps();
    await runBackgroundRead({ ...x.d, budgetMs: 1_500 });
    const saved = (x.b.s.pace ?? []).reduce((s, p) => s + p.calls, 0);
    expect(saved).toBeGreaterThan(0);
  });
});

/* R-2661 — the company's Zoho DAY budget: stop before Zoho's daily limit, carry on next day. */
describe("R-2661 day budget in the background read", () => {
  afterEach(() => { forgetDayMeters(); vi.useRealTimers(); });

  /** A memory day-row sink for one company. */
  function daySink(seed: DayCallsRow[] = []) {
    const rows = new Map(seed.map((r) => [r.day, { ...r }]));
    return {
      rows,
      sink: {
        async read(day: string) { const r = rows.get(day); return r ? { ...r } : null; },
        async add(day: string, calls: number, refusal: string | null) {
          const r = rows.get(day) ?? { day, calls: 0, limitHitAt: null };
          r.calls += calls; if (refusal && !r.limitHitAt) r.limitHitAt = new Date().toISOString();
          rows.set(day, r); return { ...r };
        },
      },
    };
  }
  /* 13 Nov 2026 10:00Z (15:30 IST); the next IST day begins 18:30Z. */
  const DAY1 = Date.parse("2026-11-13T10:00:00Z");
  const DAY2 = Date.parse("2026-11-13T19:00:00Z");

  it("stops BEFORE the call past the budget: no Zoho call for it, cursor kept, request stays, bg_error says the budget line; next IST day carries on from the same page and each document is read once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(DAY1);
    const scan = memoryScan(); const b = memoryBg(); const c = clock(DAY1); const z = fakeZoho(7);  /* 3 list pages + 7 details = 10 calls */
    const ds = daySink();
    const meter = createDayMeter("t1", ds.sink, { budget: 5, log: () => {} });
    registerDayMeter("tok-1", meter);   /* api.ts booksGet counts and refuses through the token */
    const d = { store: scan.store, bg: b.bg, kind: "customerpayments" as const, toFacts: zohoReceiptFacts, fy: "2025-26",
      access: access().a, budgetMs: 600_000, now: c.now, sleep: c.sleep, fetch: z.f, log: () => {}, dayBudget: meter };
    const r1 = await runBackgroundRead(d);
    expect(r1.outcome).toBe("day-limit");
    expect(z.calls()).toBe(5);                                   /* 3 list + 2 details; the 6th was never made */
    expect(ds.rows.get("2026-11-13")).toMatchObject({ calls: 5 });
    expect(await scan.store.counts("2025-26")).toEqual({ listed: 7, detailed: 2 });
    expect(scan.runs.get("2025-26")).toMatchObject({ listDone: true });
    expect(b.s.requestedAt).not.toBeNull();                      /* the request STAYS */
    expect(b.s.leaseUntil).toBeNull();
    expect(b.s.error).toContain("Zoho calls today: 5 of 5");
    expect(b.s.error).toContain("carries on after 12:00 am IST on 14 Nov 2026");
    /* A cron tick later the same day: nothing is called, nothing new is written. */
    const errBefore = b.s.error;
    const r2 = await runBackgroundRead(d);
    expect(r2.outcome).toBe("day-limit");
    expect(z.calls()).toBe(5);
    expect(b.s.error).toBe(errBefore);
    /* The next IST day: the pass carries on from the saved state — no list page again, the 5 details left read once each. */
    vi.setSystemTime(DAY2); c.set(DAY2);
    const r3 = await runBackgroundRead(d);
    expect(r3).toMatchObject({ outcome: "complete", listed: 7, detailed: 7 });
    expect(z.calls()).toBe(10);
    expect(ds.rows.get("2026-11-14")).toMatchObject({ calls: 5 });
    expect(b.s.requestedAt).toBeNull();
    expect(b.s.error).toBeNull();
  });

  it("the cron while the day is spent: no Zoho call, no lease, the request stays with the budget line", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(DAY1);
    const scan = memoryScan(); const b = memoryBg(); const c = clock(DAY1); const z = fakeZoho(7);
    const ds = daySink([{ day: "2026-11-13", calls: 900, limitHitAt: null }]);
    const meter = createDayMeter("t1", ds.sink, { budget: 900, log: () => {} });
    registerDayMeter("tok-1", meter);
    const d = { store: scan.store, bg: b.bg, kind: "customerpayments" as const, toFacts: zohoReceiptFacts, fy: "2025-26",
      access: access().a, budgetMs: 600_000, now: c.now, sleep: c.sleep, fetch: z.f, log: () => {}, dayBudget: meter, requireRequest: true };
    const r = await runBackgroundRead(d);
    expect(r).toMatchObject({ outcome: "day-limit", calls: 0, listed: 0, detailed: 0 });
    expect(z.calls()).toBe(0);
    expect(b.s.requestedAt).not.toBeNull();
    expect(b.s.leaseUntil).toBeNull();
    expect(b.s.error).toContain("Zoho calls today: 900 of 900");
    /* Zoho itself refused for the day (another app shares the organization): spent even at a low count. */
    const ds2 = daySink([{ day: "2026-11-13", calls: 12, limitHitAt: "2026-11-13T04:24:00Z" }]);
    const meter2 = createDayMeter("t1", ds2.sink, { budget: 900, log: () => {} });
    const b2 = memoryBg();
    const r2 = await runBackgroundRead({ ...d, bg: b2.bg, dayBudget: meter2 });
    expect(r2.outcome).toBe("day-limit");
    expect(z.calls()).toBe(0);
    expect(b2.s.error).toContain("Zoho calls today: 12 of 900");
  });

  it("without a day budget (older callers / tests) nothing changes: the year reads to the end", async () => {
    const { d } = deps();
    expect((await runBackgroundRead(d)).outcome).toBe("complete");
  });
});
