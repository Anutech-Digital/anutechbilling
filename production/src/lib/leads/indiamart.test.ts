import { describe, it, expect, vi } from "vitest";
import {
  indiamartTime, pullWindow, indiamartUrl, parseIndiamartResponse, queryTimeToIso,
  indiamartLeadId, indiamartImportArgs, MAX_WINDOW_DAYS,
} from "./indiamart";

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => { throw new Error("no DB in unit tests"); } }));
import { runIndiamartPull } from "./indiamart.server";

/* SYNTHETIC fixture, shaped after IndiaMART's documented v2 reply — NOT a captured live
   response (no key was available). Includes the messes a defensive parser must survive. */
const FIXTURE = {
  CODE: 200,
  STATUS: "SUCCESS",
  MESSAGE: "",
  TOTAL_RECORDS: 5,
  RESPONSE: [
    {
      UNIQUE_QUERY_ID: "2451111111", QUERY_TYPE: "W", QUERY_TIME: "2026-09-28 10:15:30",
      SENDER_NAME: "Rakesh Sharma", SENDER_MOBILE: "+91-9811111111", SENDER_EMAIL: "Rakesh@Example.IN",
      SUBJECT: "Requirement for Google Workspace", SENDER_COMPANY: "Sharma Traders",
      SENDER_CITY: "New Delhi", SENDER_STATE: "Delhi", SENDER_PINCODE: "110001",
      SENDER_MOBILE_ALT: "", QUERY_PRODUCT_NAME: "Google Workspace",
      QUERY_MESSAGE: "Need 10 users<br>Business Starter &nbsp;plan",
    },
    // same enquiry twice in one reply
    { UNIQUE_QUERY_ID: "2451111111", QUERY_TYPE: "W", SENDER_NAME: "Rakesh Sharma" },
    // numeric id, no company, odd time
    { UNIQUE_QUERY_ID: 2452222222, QUERY_TYPE: "P", QUERY_TIME: "yesterday", SENDER_NAME: "Priya", SENDER_MOBILE: "09822222222", SENDER_EMAIL: "not-an-email" },
    // no id → skipped, not guessed
    { SENDER_NAME: "Ghost" },
    "garbage",
  ],
};

describe("request", () => {
  it("formats times in IST as DD-Mon-YYYY HH:MM:SS", () => {
    expect(indiamartTime(new Date("2026-09-28T04:45:05Z"))).toBe("28-Sep-2026 10:15:05");
    // 20:00 UTC is already the next day in India
    expect(indiamartTime(new Date("2026-12-31T20:00:00Z"))).toBe("01-Jan-2027 01:30:00");
  });
  it("window: 24 h on first run, overlaps the last end, never longer than 7 days", () => {
    const now = new Date("2026-09-28T06:00:00Z");
    expect(pullWindow(null, now).start.toISOString()).toBe("2026-09-27T06:00:00.000Z");
    expect(pullWindow(new Date("2026-09-28T05:00:00Z"), now).start.toISOString()).toBe("2026-09-28T04:50:00.000Z");
    const old = pullWindow(new Date("2026-08-01T00:00:00Z"), now);
    expect(now.getTime() - old.start.getTime()).toBeLessThan(MAX_WINDOW_DAYS * 86_400_000);
  });
  it("puts the key and window in the query string", () => {
    const u = new URL(indiamartUrl("KEY123", new Date("2026-09-27T06:00:00Z"), new Date("2026-09-28T06:00:00Z")));
    expect(u.origin + u.pathname).toBe("https://mapi.indiamart.com/wservce/crm/crmListing/v2/");
    expect(u.searchParams.get("glusr_crm_key")).toBe("KEY123");
    expect(u.searchParams.get("start_time")).toBe("27-Sep-2026 11:30:00");
    expect(u.searchParams.get("end_time")).toBe("28-Sep-2026 11:30:00");
  });
});

describe("parseIndiamartResponse", () => {
  it("parses the fixture defensively: dedupes within the reply, skips rows without an id", () => {
    const r = parseIndiamartResponse(FIXTURE);
    if (!r.ok) throw new Error("expected ok");
    expect(r.leads.map((l) => l.queryId)).toEqual(["2451111111", "2452222222"]);
    expect(r.skipped).toBe(2);
    const [a, b] = r.leads;
    expect(a).toMatchObject({
      name: "Rakesh Sharma", company: "Sharma Traders", email: "rakesh@example.in", phone: "+919811111111",
      state: "Delhi", product: "Google Workspace", queryType: "W",
      queryTime: "2026-09-28T04:45:30.000Z", message: "Need 10 users\nBusiness Starter  plan",
    });
    expect(a.altPhone).toBeNull();
    expect(b).toMatchObject({ company: null, email: null, phone: "+919822222222", queryTime: null });
  });
  it("no leads in the window is success, not an error", () => {
    expect(parseIndiamartResponse({ CODE: 204, STATUS: "SUCCESS", MESSAGE: "There are no leads in the given time duration." }))
      .toEqual({ ok: true, leads: [], skipped: 0 });
  });
  it("rate limit, bad key and other errors are told apart", () => {
    expect(parseIndiamartResponse({ CODE: 429, MESSAGE: "It is advised to hit this API once in every 5 minutes" }))
      .toMatchObject({ ok: false, kind: "rate_limited" });
    expect(parseIndiamartResponse({ CODE: 401, MESSAGE: "Invalid Key" })).toMatchObject({ ok: false, kind: "auth" });
    expect(parseIndiamartResponse(null, 502)).toMatchObject({ ok: false, kind: "error" });
    expect(parseIndiamartResponse("<html>", 200)).toMatchObject({ ok: false, kind: "error" });
    expect(parseIndiamartResponse({ CODE: 500, MESSAGE: "boom" })).toEqual({ ok: false, kind: "error", message: "boom" });
  });
  it("QUERY_TIME is read as IST, and a bad one is null rather than a guess", () => {
    expect(queryTimeToIso("2026-09-28 00:10:00")).toBe("2026-09-27T18:40:00.000Z");
    expect(queryTimeToIso("28/09/2026")).toBeNull();
  });
});

describe("lead mapping", () => {
  it("lead id is deterministic per tenant + query id", () => {
    const t = "fbb976f1-9090-4f10-9726-0901bd144e42";
    expect(indiamartLeadId(t, "2451111111")).toBe("L-IM-FBB976F1-2451111111");
    expect(indiamartLeadId("0a0a0a0a-0000-0000-0000-000000000000", "2451111111")).not.toBe(indiamartLeadId(t, "2451111111"));
  });
  it("builds the import args with notes a rep can act on", () => {
    const r = parseIndiamartResponse(FIXTURE);
    if (!r.ok) throw new Error("expected ok");
    const args = indiamartImportArgs("t-1", r.leads[0]);
    expect(args).toMatchObject({
      p_tenant_id: "t-1", p_query_id: "2451111111", p_company: "Sharma Traders",
      p_contact_name: "Rakesh Sharma", p_phone: "+919811111111", p_query_type: "W",
    });
    expect(args.p_notes).toContain("IndiaMART Direct enquiry · query 2451111111");
    expect(args.p_notes).toContain("Product: Google Workspace");
    expect(args.p_notes).toContain("Location: New Delhi, Delhi, 110001");
  });
});

/* ─── Runner, with a fake DB and a fake fetch — no network, ever ─────────── */

function fakeDb(opts: { keys: { tenant_id: string; indiamart_crm_key: string | null }[]; state?: Record<string, unknown>; imported?: Set<string> }) {
  const imported = opts.imported ?? new Set<string>();
  const upserts: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => {
    const k = `${args.p_tenant_id}|${args.p_query_id}`;
    if (imported.has(k)) return { data: null, error: null };
    imported.add(k);
    return { data: args.p_lead_id, error: null };
  });
  const from = (table: string) => {
    const b = {
      select: () => b,
      not: () => Promise.resolve({ data: opts.keys, error: null }),
      eq: () => b,
      maybeSingle: () => Promise.resolve({ data: table === "indiamart_sync_state" ? (opts.state ?? null) : null, error: null }),
      upsert: (row: Record<string, unknown>) => { upserts.push(row); return Promise.resolve({ error: null }); },
    };
    return b;
  };
  return { admin: { from, rpc } as never, rpc, upserts, imported };
}

const okFetch = (body: unknown, status = 200) =>
  vi.fn(async () => ({ status, json: async () => body }) as unknown as Response);

describe("runIndiamartPull", () => {
  const now = new Date("2026-09-28T06:00:00Z");

  it("no key anywhere → disabled, and IndiaMART is never called", async () => {
    const db = fakeDb({ keys: [{ tenant_id: "t1", indiamart_crm_key: "  " }] });
    const f = okFetch(FIXTURE);
    const r = await runIndiamartPull({ admin: db.admin, now, fetchImpl: f });
    expect(r.disabled).toBe(true);
    expect(f).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("imports each enquiry once; a second run over the same window only counts duplicates", async () => {
    const db = fakeDb({ keys: [{ tenant_id: "t1", indiamart_crm_key: "KEY-0123456789ABCDEF" }] });
    const r1 = await runIndiamartPull({ admin: db.admin, now, fetchImpl: okFetch(FIXTURE) });
    expect(r1).toMatchObject({ disabled: false, tenants: 1, imported: 2, duplicates: 0, skipped_rows: 2, failed: 0 });
    const r2 = await runIndiamartPull({ admin: db.admin, now, fetchImpl: okFetch(FIXTURE) });
    expect(r2).toMatchObject({ imported: 0, duplicates: 2 });
    expect(db.upserts.at(-1)).toMatchObject({ tenant_id: "t1", last_ok: true, last_end_at: now.toISOString() });
  });

  it("rate limited → backs off, does not move the window, not a failure", async () => {
    const db = fakeDb({ keys: [{ tenant_id: "t1", indiamart_crm_key: "KEY-0123456789ABCDEF" }] });
    const r = await runIndiamartPull({ admin: db.admin, now, fetchImpl: okFetch({ CODE: 429, MESSAGE: "hit this API once in every 5 minutes" }) });
    expect(r).toMatchObject({ rate_limited: 1, failed: 0, imported: 0 });
    expect(db.upserts[0]).not.toHaveProperty("last_end_at");
    expect(db.upserts[0].next_allowed_at).toBe("2026-09-28T06:15:00.000Z");
  });

  it("still inside a back-off → skipped without calling IndiaMART", async () => {
    const db = fakeDb({ keys: [{ tenant_id: "t1", indiamart_crm_key: "KEY-0123456789ABCDEF" }], state: { next_allowed_at: "2026-09-28T06:10:00Z" } });
    const f = okFetch(FIXTURE);
    await runIndiamartPull({ admin: db.admin, now, fetchImpl: f });
    expect(f).not.toHaveBeenCalled();
  });

  it("a bad key is a failure with a next step, and the key never appears in the error", async () => {
    const db = fakeDb({ keys: [{ tenant_id: "t1", indiamart_crm_key: "SECRET-KEY-DO-NOT-LOG" }] });
    const r = await runIndiamartPull({ admin: db.admin, now, fetchImpl: okFetch({ CODE: 401, MESSAGE: "Invalid Key" }) });
    expect(r.failed).toBe(1);
    expect(r.errors[0].message).toMatch(/save the key again/);
    expect(JSON.stringify(r)).not.toContain("SECRET-KEY-DO-NOT-LOG");
  });

  it("a network error never leaks the URL (which carries the key)", async () => {
    const db = fakeDb({ keys: [{ tenant_id: "t1", indiamart_crm_key: "SECRET-KEY-DO-NOT-LOG" }] });
    const f = vi.fn(async (u: string) => { throw new TypeError(`fetch failed ${u}`); });
    const r = await runIndiamartPull({ admin: db.admin, now, fetchImpl: f as unknown as typeof fetch });
    expect(r.failed).toBe(1);
    expect(JSON.stringify(r)).not.toContain("SECRET-KEY-DO-NOT-LOG");
  });
});
