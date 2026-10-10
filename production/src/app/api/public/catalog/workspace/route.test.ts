/**
 * R-703: the website catalog endpoint serves the last good price list when the database
 * does not answer, instead of 503 (847 × on 9–10 Oct 2026).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const st = vi.hoisted(() => ({
  result: (): Promise<unknown> => Promise.resolve({ data: [], error: null }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    for (const k of ["from", "select", "eq", "in"]) q[k] = () => q;
    q.order = () => st.result();
    return q;
  },
}));

import { GET } from "./route";
import { forgetForTests, MAX_STALE_MS, READ_BUDGET_MS } from "./last-good";

const row = { name: "Google Workspace Business Starter", msrp: 3240, vendor: "google", prices: { annual: 270, monthly: 325 } };
const good = () => Promise.resolve({ data: [row], error: null });
const down = () => Promise.resolve({ data: null, error: { message: "TypeError: fetch failed", details: "UND_ERR_CONNECT_TIMEOUT", code: "" } });

beforeEach(() => {
  forgetForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); });

describe("GET /api/public/catalog/workspace (R-703)", () => {
  it("answers the live list when the database answers", async () => {
    st.result = good;
    const r = await GET();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.stale).toBeUndefined();
    expect(Array.isArray(body.items)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/wholesale|margin_pct/);
  });

  it("serves the last good list (stale:true) when the database errors", async () => {
    st.result = good;
    const fresh = await (await GET()).json();
    st.result = down;
    const r = await GET();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.stale).toBe(true);
    expect(body.items).toEqual(fresh.items);
    expect(typeof body.asOf).toBe("string");
  });

  it("does not wait out a hung database when it has a list to serve", async () => {
    st.result = good;
    await GET();
    vi.useFakeTimers();
    st.result = () => new Promise(() => {}); // never answers
    const pending = GET();
    await vi.advanceTimersByTimeAsync(READ_BUDGET_MS + 10);
    const r = await pending;
    expect(r.status).toBe(200);
    expect((await r.json()).stale).toBe(true);
  });

  it("still answers 503 (website uses its fallback) when nothing good was ever read", async () => {
    st.result = down;
    const r = await GET();
    expect(r.status).toBe(503);
  });

  it("does not serve a list older than a day — prices may have been edited", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    st.result = good;
    await GET();
    vi.setSystemTime(new Date(Date.parse("2026-10-09T00:00:00Z") + MAX_STALE_MS + 60_000));
    st.result = down;
    const r = await GET();
    expect(r.status).toBe(503);
  });
});
