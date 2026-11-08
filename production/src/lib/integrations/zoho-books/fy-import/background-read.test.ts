/**
 * R-2607 — the FY read runs on the server (cron zoho-fy-read + the open dialog), not in a browser
 * tab: lease (one pass at a time), resume after a dead pass, Zoho busy / 429, token refused mid-run,
 * not connected, empty year, DB hiccup, tenant isolation. Zoho is a fake fetch (never the real one);
 * the stores are memory. Names and numbers are made up.
 */
import { describe, it, expect } from "vitest";
import { ZohoApiError } from "../api";
import { runBackgroundRead, LEASE_EXTRA_MS, RECONNECT_MESSAGE, type BgState, type BgStore, type ZohoAccess } from "./background-read";
import type { ScanRun, ScanStore, ListedRow, ScanFacts } from "./scan";
import { zohoReceiptFacts } from "../receipts-import/normalise";

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
    async touch(_fy, now) { s.lastStepAt = new Date(now).toISOString(); },
    async release(_fy, end) {
      s.leaseUntil = null; s.error = end.error;
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
      access: access().a, budgetMs: 600_000, now: c.now, sleep: c.sleep, fetch: z.f, ...over },
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
