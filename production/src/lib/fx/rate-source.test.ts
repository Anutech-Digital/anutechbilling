/* R-045 slice 3 — FX rate source: FBIL/RBI reference first, indicative fallback, labelled,
   cached per day. NO network: every test passes its own fetch. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  fetchInrRate, parseFbilReferenceRates, parseErApi, parseFrankfurter, __resetFxCache,
  fxSourceLabel, fxSourcePdfLabel, fxKindOf, fxEquivalentLine, formatFxDate, toIsoDate,
  manualFxStamp, fxStampFromQuote,
} from "./rate-source";

const FBIL_ROWS = [
  { processRunDate: "2026-09-29 00:00:00", subProdName: "INR / 1 USD", rate: 96.0321 },
  { processRunDate: "2026-09-30 00:00:00", subProdName: "INR / 1 USD", rate: 95.9832 },
  { processRunDate: "2026-09-30 00:00:00", subProdName: "INR / 1 EUR", rate: 108.9368 },
  { processRunDate: "2026-09-30 00:00:00", subProdName: "INR / 100 JPY", rate: 61.16 },
];
const ER_OK = { result: "success", rates: { INR: 84.12345 }, time_last_update_utc: "Tue, 06 Oct 2026 00:02:31 +0000" };
const FR_OK = { rates: { INR: 84.5 }, date: "2026-10-06" };

const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

/** A fetch that answers per host; `null` = network error. */
function fakeFetch(map: { fbil?: unknown | null; er?: unknown | null; fr?: unknown | null }) {
  return vi.fn(async (url: string) => {
    const pick = url.includes("fbil.org.in") ? map.fbil : url.includes("er-api") ? map.er : map.fr;
    if (pick === undefined || pick === null) throw new Error("network down");
    return json(pick);
  });
}

const NOW = new Date("2026-10-07T06:00:00Z"); // 11:30 IST, 7 Oct

beforeEach(() => __resetFxCache());

describe("parsers", () => {
  it("FBIL: latest date wins, per-unit for 'INR / 100 JPY'", () => {
    expect(parseFbilReferenceRates(FBIL_ROWS, "USD")).toEqual({ rate: 95.9832, asOf: "2026-09-30" });
    expect(parseFbilReferenceRates(FBIL_ROWS, "jpy")).toEqual({ rate: 0.6116, asOf: "2026-09-30" });
    expect(parseFbilReferenceRates(FBIL_ROWS, "SGD")).toBeNull();      // FBIL does not publish SGD
    expect(parseFbilReferenceRates({ error: 1 }, "USD")).toBeNull();
    expect(parseFbilReferenceRates([{ subProdName: "INR / 1 USD", rate: 0, processRunDate: "2026-09-30" }], "USD")).toBeNull();
  });
  it("er-api / frankfurter: only a positive INR rate counts", () => {
    expect(parseErApi(ER_OK)).toEqual({ rate: 84.12345, asOf: "2026-10-06" });
    expect(parseErApi({ result: "error" })).toBeNull();
    expect(parseFrankfurter(FR_OK)).toEqual({ rate: 84.5, asOf: "2026-10-06" });
    expect(parseFrankfurter({ rates: {} })).toBeNull();
  });
  it("toIsoDate", () => {
    expect(toIsoDate("2026-09-30 00:00:00")).toBe("2026-09-30");
    expect(toIsoDate("")).toBeNull();
    expect(toIsoDate(42)).toBeNull();
  });
});

describe("fetchInrRate — source order + labels", () => {
  it("uses the FBIL reference rate when reachable, labelled 'reference'", async () => {
    const f = fakeFetch({ fbil: FBIL_ROWS, er: ER_OK });
    const r = await fetchInrRate("usd", { fetchImpl: f, now: NOW });
    expect(r).toMatchObject({ rate: 95.9832, from: "USD", to: "INR", asOf: "2026-09-30", source: "fbil", kind: "reference" });
    expect(r?.label).toMatch(/FBIL reference rate/);
    expect(f).toHaveBeenCalledTimes(1); // no indicative call needed
  });

  it("FBIL down → open.er-api.com, clearly 'indicative'", async () => {
    const r = await fetchInrRate("USD", { fetchImpl: fakeFetch({ fbil: null, er: ER_OK }), now: NOW });
    expect(r).toMatchObject({ rate: 84.1235, source: "er-api", kind: "indicative", asOf: "2026-10-06" });
    expect(r?.label).toMatch(/Indicative/);
    expect(r?.label).toMatch(/not the RBI reference rate/);
  });

  it("currency FBIL does not publish (SGD) → indicative", async () => {
    const r = await fetchInrRate("SGD", { fetchImpl: fakeFetch({ fbil: FBIL_ROWS, er: ER_OK }), now: NOW });
    expect(r?.source).toBe("er-api");
  });

  it("FBIL figure older than 14 days is not used", async () => {
    const old = [{ processRunDate: "2026-09-01 00:00:00", subProdName: "INR / 1 USD", rate: 90 }];
    const r = await fetchInrRate("USD", { fetchImpl: fakeFetch({ fbil: old, er: ER_OK }), now: NOW });
    expect(r?.source).toBe("er-api");
  });

  it("FBIL + er-api down → frankfurter (ECB), indicative", async () => {
    const r = await fetchInrRate("EUR", { fetchImpl: fakeFetch({ fbil: null, er: null, fr: FR_OK }), now: NOW });
    expect(r).toMatchObject({ rate: 84.5, source: "frankfurter", kind: "indicative" });
  });

  it("every source down → null (never a made-up number)", async () => {
    expect(await fetchInrRate("USD", { fetchImpl: fakeFetch({}), now: NOW })).toBeNull();
  });

  it("a non-OK HTTP answer is skipped", async () => {
    const f = vi.fn(async (url: string) => (url.includes("fbil") ? json(null, false) : json(ER_OK)));
    expect((await fetchInrRate("USD", { fetchImpl: f, now: NOW }))?.source).toBe("er-api");
  });

  it("INR → identity, no fetch", async () => {
    const f = fakeFetch({});
    expect(await fetchInrRate("INR", { fetchImpl: f, now: NOW })).toMatchObject({ rate: 1, source: "identity" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("cache per day", () => {
  it("a reference rate is reused the rest of the IST day, re-fetched the next day", async () => {
    const f = fakeFetch({ fbil: FBIL_ROWS });
    await fetchInrRate("USD", { fetchImpl: f, now: NOW });
    await fetchInrRate("USD", { fetchImpl: f, now: new Date("2026-10-07T17:00:00Z") }); // 22:30 IST same day
    expect(f).toHaveBeenCalledTimes(1);
    await fetchInrRate("USD", { fetchImpl: f, now: new Date("2026-10-07T19:00:00Z") }); // 00:30 IST 8 Oct
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("an indicative rate is kept only an hour, so FBIL is retried", async () => {
    const f = fakeFetch({ fbil: null, er: ER_OK });
    await fetchInrRate("USD", { fetchImpl: f, now: NOW });
    const calls = f.mock.calls.length;
    await fetchInrRate("USD", { fetchImpl: f, now: new Date(NOW.getTime() + 30 * 60_000) });
    expect(f.mock.calls.length).toBe(calls);
    await fetchInrRate("USD", { fetchImpl: f, now: new Date(NOW.getTime() + 61 * 60_000) });
    expect(f.mock.calls.length).toBeGreaterThan(calls);
  });
});

describe("labels + PDF line", () => {
  it("kinds and labels", () => {
    expect(fxKindOf("fbil")).toBe("reference");
    expect(fxKindOf("er-api")).toBe("indicative");
    expect(fxKindOf("manual")).toBe("manual");
    expect(fxKindOf(null)).toBeNull();
    expect(fxSourceLabel(undefined)).toBeNull();
    expect(fxSourcePdfLabel("fbil")).toBe("FBIL/RBI reference rate");
  });

  it("'₹ equivalent at 1 USD = ₹X (source, date)'", () => {
    expect(fxEquivalentLine({ currency: "USD", rate: 95.9832, source: "fbil", date: "2026-09-30" }))
      .toBe("₹ equivalent at 1 USD = ₹95.9832 (FBIL/RBI reference rate, 30 Sep 2026)");
    expect(fxEquivalentLine({ currency: "USD", rate: 84.12, source: "er-api", date: "2026-10-06" }))
      .toBe("₹ equivalent at 1 USD = ₹84.12 (indicative market rate, 6 Oct 2026)");
    // An invoice issued before R-045: no source/date recorded → just the rate, nothing invented.
    expect(fxEquivalentLine({ currency: "USD", rate: 83, source: null, date: null })).toBe("₹ equivalent at 1 USD = ₹83");
  });

  it("formatFxDate", () => {
    expect(formatFxDate("2026-01-05")).toBe("5 Jan 2026");
    expect(formatFxDate("junk")).toBeNull();
  });

  it("stamps: typed = manual dated today; old quote keeps NULLs", () => {
    expect(manualFxStamp("2026-10-07")).toMatchObject({ source: "manual", asOf: "2026-10-07", kind: "manual" });
    expect(fxStampFromQuote({ fx_source: null, fx_date: null })).toMatchObject({ source: null, asOf: null });
    expect(fxStampFromQuote({ fx_source: "fbil", fx_date: "2026-09-30" })).toMatchObject({ kind: "reference" });
  });
});
