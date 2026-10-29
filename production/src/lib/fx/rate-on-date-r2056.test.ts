/* R-2056 (28 Oct 2026, Pardeep: "exchange ka latest rate khud aana chahiye, par editable ho") —
   the ₹ rate FOR A DATE (a bill's date), FBIL/RBI reference first, ECB (frankfurter) next,
   cached per IST day. NO network: every test passes its own fetch. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fetchInrRateOn, parseFbilReferenceRateOn, fxRateHint, __resetFxCache } from "./rate-source";

/* FBIL's refrates/fetch gives the last couple of publish days — newest first. */
const FBIL_ROWS = [
  { processRunDate: "2026-10-21 00:00:00", subProdName: "INR / 1 USD", rate: 94.7145 },
  { processRunDate: "2026-10-21 00:00:00", subProdName: "INR / 1 EUR", rate: 106.2839 },
  { processRunDate: "2026-10-19 00:00:00", subProdName: "INR / 1 USD", rate: 94.7691 },
];
const json = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

function fakeFetch(map: { fbil?: unknown; er?: unknown; fr?: unknown }) {
  return vi.fn(async (url: string) => {
    const pick = url.includes("fbil.org.in") ? map.fbil : url.includes("er-api") ? map.er : map.fr;
    if (pick === undefined || pick === null) throw new Error("network down");
    return json(pick);
  });
}

const NOW = new Date("2026-10-28T06:00:00Z"); // 11:30 IST, 28 Oct
beforeEach(() => __resetFxCache());

describe("parseFbilReferenceRateOn", () => {
  it("picks the newest FBIL day ON or BEFORE the date", () => {
    expect(parseFbilReferenceRateOn(FBIL_ROWS, "USD", "2026-10-21")).toEqual({ rate: 94.7145, asOf: "2026-10-21" });
    expect(parseFbilReferenceRateOn(FBIL_ROWS, "USD", "2026-10-20")).toEqual({ rate: 94.7691, asOf: "2026-10-19" });
    expect(parseFbilReferenceRateOn(FBIL_ROWS, "USD", "2026-10-18")).toBeNull();
    expect(parseFbilReferenceRateOn(FBIL_ROWS, "SGD", "2026-10-21")).toBeNull();
  });
});

describe("fetchInrRateOn — the bill date's rate", () => {
  it("a weekend/holiday bill date uses FBIL's last publish day before it (within 4 days)", async () => {
    const f = fakeFetch({ fbil: FBIL_ROWS, fr: { date: "2026-10-23", rates: { INR: 94.94 } } });
    const r = await fetchInrRateOn("usd", "2026-10-22", { fetchImpl: f, now: NOW });
    expect(r).toMatchObject({ rate: 94.7145, asOf: "2026-10-21", source: "fbil", kind: "reference" });
  });

  it("FBIL has no row near the date → ECB rate for that date (frankfurter, dated URL), labelled indicative", async () => {
    const f = fakeFetch({ fbil: FBIL_ROWS, fr: { date: "2026-10-23", rates: { INR: 94.94 } } });
    const r = await fetchInrRateOn("USD", "2026-10-26", { fetchImpl: f, now: NOW });
    expect(r).toMatchObject({ rate: 94.94, asOf: "2026-10-23", source: "frankfurter", kind: "indicative" });
    expect(f.mock.calls.some(([u]) => String(u).includes("frankfurter.app/2026-10-26?from=USD&to=INR"))).toBe(true);
  });

  it("a PAST date never uses er-api (it only knows today's rate)", async () => {
    const f = fakeFetch({ fbil: [], er: { result: "success", rates: { INR: 99 } } });
    expect(await fetchInrRateOn("USD", "2026-10-01", { fetchImpl: f, now: NOW })).toBeNull();
    expect(f.mock.calls.some(([u]) => String(u).includes("er-api"))).toBe(false);
  });

  it("today / a future date / no date → the latest rate (same as fetchInrRate)", async () => {
    const f = fakeFetch({ fbil: FBIL_ROWS });
    expect(await fetchInrRateOn("USD", "2026-10-28", { fetchImpl: f, now: NOW })).toMatchObject({ rate: 94.7145, source: "fbil" });
    expect(await fetchInrRateOn("USD", "2026-11-02", { fetchImpl: f, now: NOW })).toMatchObject({ rate: 94.7145 });
    expect(await fetchInrRateOn("USD", null, { fetchImpl: f, now: NOW })).toMatchObject({ rate: 94.7145 });
  });

  it("cached per currency + date for the IST day — the second ask makes no request", async () => {
    const f = fakeFetch({ fbil: FBIL_ROWS, fr: { date: "2026-10-23", rates: { INR: 94.94 } } });
    await fetchInrRateOn("USD", "2026-10-26", { fetchImpl: f, now: NOW });
    const calls = f.mock.calls.length;
    await fetchInrRateOn("USD", "2026-10-26", { fetchImpl: f, now: new Date("2026-10-28T12:00:00Z") });
    expect(f.mock.calls.length).toBe(calls);
    await fetchInrRateOn("USD", "2026-10-26", { fetchImpl: f, now: new Date("2026-10-29T06:00:00Z") });
    expect(f.mock.calls.length).toBeGreaterThan(calls);   // next IST day → fetched again
  });

  it("every source down → null, never an invented number", async () => {
    const f = fakeFetch({});
    expect(await fetchInrRateOn("USD", "2026-10-25", { fetchImpl: f, now: NOW })).toBeNull();
  });

  it("INR → 1", async () => {
    expect(await fetchInrRateOn("INR", "2026-10-25", { fetchImpl: fakeFetch({}), now: NOW })).toMatchObject({ rate: 1, source: "identity" });
  });
});

describe("fxRateHint — the line under the box", () => {
  it("says the rate, source, date and that it can be changed", () => {
    expect(fxRateHint({ rate: 94.7145, asOf: "2026-10-21", source: "fbil" }))
      .toBe("₹94.7145 · FBIL/RBI reference rate, 21 Oct 2026 — change it if your bank charged a different rate");
    expect(fxRateHint({ rate: 94.94, asOf: "2026-10-23", source: "frankfurter" }))
      .toBe("₹94.94 · indicative market rate (ECB), 23 Oct 2026 — not the RBI reference rate; change it if your bank charged a different rate");
  });
});
