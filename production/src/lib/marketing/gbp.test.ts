import { describe, it, expect } from "vitest";
import {
  totalsOf, comparePeriods, dailySeries, weeklySeries, reviewStats, draftReply, insights,
  metricRowsFromPayload, starToNumber, metricsCsvRows, type MetricRow,
} from "./gbp";

const R = (day: string, metric: string, value: number): MetricRow => ({ day, metric, value });

describe("gbp metrics", () => {
  it("splits impressions by surface and device and sums actions", () => {
    const t = totalsOf([
      R("2026-09-01", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", 10),
      R("2026-09-01", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", 30),
      R("2026-09-01", "CALL_CLICKS", 2),
      R("2026-09-01", "WEBSITE_CLICKS", 1),
      R("2026-09-01", "BUSINESS_DIRECTION_REQUESTS", 1),
    ]);
    expect(t.impressions).toBe(40);
    expect(t.maps).toBe(10); expect(t.search).toBe(30);
    expect(t.desktop).toBe(10); expect(t.mobile).toBe(30);
    expect(t.actions).toBe(4);
    expect(t.actionRate).toBe(10);
  });

  it("compares the last 28 published days with the 28 before, ending 3 days back", () => {
    const rows: MetricRow[] = [];
    // 2026-07-31 .. 2026-09-24 : 100 impressions/day until 27 Aug, then 150/day
    for (let d = new Date("2026-07-31T00:00:00Z"); d <= new Date("2026-09-24T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      rows.push(R(iso, "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", iso >= "2026-08-28" ? 150 : 100));
      rows.push(R(iso, "CALL_CLICKS", 1));
    }
    const c = comparePeriods(rows, "2026-09-27");
    expect(c.to).toBe("2026-09-24");
    expect(c.from).toBe("2026-08-28");
    expect(c.current.impressions).toBe(150 * 28);
    expect(c.previous.impressions).toBe(100 * 28);
    expect(c.change.impressions).toBe(50);
    expect(c.change.calls).toBe(0);
    expect(c.change.directions).toBeNull();   // nothing before → no percentage
  });

  it("daily series fills missing days with zeros; weekly buckets start Monday", () => {
    const s = dailySeries([R("2026-09-02", "CALL_CLICKS", 3)], "2026-09-01", "2026-09-03");
    expect(s.map((p) => p.calls)).toEqual([0, 3, 0]);
    const w = weeklySeries(dailySeries([R("2026-09-06", "CALL_CLICKS", 1), R("2026-09-07", "CALL_CLICKS", 2)], "2026-09-06", "2026-09-07"));
    expect(w).toEqual([
      { day: "2026-08-31", impressions: 0, actions: 1, calls: 1, website: 0, directions: 0 },   // Sunday 6 Sep → week of Mon 31 Aug
      { day: "2026-09-07", impressions: 0, actions: 2, calls: 2, website: 0, directions: 0 },
    ]);
  });

  it("flattens Google's nested performance payload", () => {
    const rows = metricRowsFromPayload({
      multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
        { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 5 }, value: "4" }, { date: { year: 2026, month: 9, day: 6 } }] } },
        { dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 5 }, value: 2 }] } },
      ] }],
    });
    expect(rows).toEqual([
      { day: "2026-09-05", metric: "CALL_CLICKS", value: 4 },
      { day: "2026-09-06", metric: "CALL_CLICKS", value: 0 },
      { day: "2026-09-05", metric: "WEBSITE_CLICKS", value: 2 },
    ]);
    expect(metricsCsvRows(rows)).toEqual([["2026-09-05", 0, 0, 0, 4, 2, 0, 0, 0], ["2026-09-06", 0, 0, 0, 0, 0, 0, 0, 0]]);
  });

  it("maps star words", () => {
    expect(starToNumber("FIVE")).toBe(5);
    expect(starToNumber("two")).toBe(2);
    expect(starToNumber("STAR_RATING_UNSPECIFIED")).toBeNull();
  });
});

describe("gbp reviews", () => {
  const rv = (star: number, at: string, reply: string | null = null, name = "Amit Kumar") => ({ star_rating: star, comment: "x", reply_comment: reply, reviewed_at: at, reviewer_name: name });

  it("average, distribution, unanswered, overdue past the 3-day SLA, last-30", () => {
    const s = reviewStats([
      rv(5, "2026-09-26T10:00:00Z"),                 // unanswered, 1 day old → not overdue
      rv(1, "2026-09-10T10:00:00Z"),                 // unanswered, 17 days → overdue
      rv(4, "2026-08-01T10:00:00Z", "Thanks!"),      // replied, older than 30 days
    ], "2026-09-27");
    expect(s.count).toBe(3);
    expect(s.average).toBe(3.3);
    expect(s.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1, 5: 1 });
    expect(s.unanswered).toBe(2);
    expect(s.overdue).toBe(1);
    expect(s.last30).toBe(2);
    expect(s.last30Average).toBe(3);
    expect(s.replyRate).toBe(33);
  });

  it("drafts a reply that fits the rating", () => {
    expect(draftReply(rv(5, "2026-09-01"), "Anutech")).toMatch(/^Thank you, Amit, for taking the time to review Anutech/);
    expect(draftReply(rv(1, "2026-09-01", null, "A Google User"), "Anutech", "98765")).toMatch(/^Thank you for telling us.*contact us directly at 98765/);
    expect(draftReply(rv(3, "2026-09-01"), "Anutech")).toContain("honest feedback");
  });

  it("insights: overdue replies first, then listing gaps, then trend", () => {
    const stats = reviewStats([rv(2, "2026-09-01")], "2026-09-27");
    const cmp = comparePeriods([], "2026-09-27");
    const list = insights(cmp, stats, { hasWebsite: false, hasPhone: true, reviewLinkSaved: true });
    expect(list[0].kind).toBe("act");
    expect(list[0].text).toMatch(/unanswered/);
    expect(list.some((i) => i.href === "/marketing/links")).toBe(true);
    const fine = insights(comparePeriods([], "2026-09-27"), reviewStats([rv(5, "2026-09-20", "ty")], "2026-09-27"), { hasWebsite: true, hasPhone: true, reviewLinkSaved: true });
    expect(fine).toEqual([{ kind: "good", text: expect.stringMatching(/All good/) }]);
  });
});
