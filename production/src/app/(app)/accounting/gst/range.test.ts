import { describe, expect, it } from "vitest";
import { GST_START, gstAllToDate, gstAllToDateHref, gstDefaultRange, gstRangeFromParams, gstRangeHref, gstThisFy } from "./range";

/* IST instants: 6 Oct 2026 10:00 IST = 04:30Z. */
const oct6 = new Date("2026-10-06T04:30:00Z");
const oct21 = new Date("2026-10-21T04:30:00Z");

describe("R-257 GST page range", () => {
  it("opens on last month during the 1st-20th (return being filed) — the bug: 6 Oct opened an empty October", () => {
    expect(gstDefaultRange(oct6)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("opens on this month from the 21st", () => {
    expect(gstDefaultRange(oct21)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("uses the IST day, not UTC: 20 Oct 23:00 IST is still the 20th, 21 Oct 00:30 IST is the 21st", () => {
    expect(gstDefaultRange(new Date("2026-10-20T17:30:00Z")).from).toBe("2026-09-01");
    expect(gstDefaultRange(new Date("2026-10-20T19:00:00Z")).from).toBe("2026-10-01");
  });

  it("This FY is April to March, and Jan-Mar belong to the previous year's FY", () => {
    expect(gstThisFy(oct6)).toEqual({ from: "2026-04-01", to: "2027-03-31", label: "FY 2026-27" });
    expect(gstThisFy(new Date("2027-02-10T04:30:00Z"))).toMatchObject({ from: "2026-04-01", to: "2027-03-31" });
  });

  it("the Overview tile link covers everything since GST began up to today (the tile's cumulative span)", () => {
    expect(gstAllToDate(oct6)).toEqual({ from: GST_START, to: "2026-10-06", label: "All to date" });
    expect(gstAllToDateHref(oct6)).toBe("/accounting/gst?from=2017-07-01&to=2026-10-06");
  });

  it("R-394: the Overview GST tile links to exactly the range its number covers", () => {
    const r = gstDefaultRange(oct6);
    expect(gstRangeHref(r)).toBe(`/accounting/gst?from=${r.from}&to=${r.to}`);
    expect(gstRangeFromParams(r.from, r.to, oct6)).toEqual(r);
  });

  it("reads ?from=&to= and keeps the named label so the chip lights up", () => {
    expect(gstRangeFromParams("2017-07-01", "2026-10-06", oct6).label).toBe("All to date");
    expect(gstRangeFromParams("2026-04-01", "2027-03-31", oct6).label).toBe("FY 2026-27");
    expect(gstRangeFromParams("2026-05-03", "2026-06-10", oct6)).toEqual({ from: "2026-05-03", to: "2026-06-10", label: "2026-05-03 to 2026-06-10" });
  });

  it("a missing, malformed or backwards range falls back to the default", () => {
    const def = gstDefaultRange(oct6);
    expect(gstRangeFromParams(null, null, oct6)).toEqual(def);
    expect(gstRangeFromParams("2026-10", "2026-10-31", oct6)).toEqual(def);
    expect(gstRangeFromParams("2026-10-31", "2026-10-01", oct6)).toEqual(def);
  });
});
