import { describe, it, expect } from "vitest";
import {
  istGreeting,
  toIstDate, istToday, istMonth, istParts, addDaysISO, daysBetweenISO, istDayStartUtc,
  fyStartYear, fyLabel, fyBounds, monthBounds, formatIstDate,
} from "./ist";

const intlIst = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

describe("istToday — the 00:00–05:30 IST window that toISOString gets wrong", () => {
  it("02:00 IST on 1 Apr is 1 Apr, while UTC still says 31 Mar", () => {
    const at = new Date("2026-03-31T20:30:00Z"); // 02:00 IST, 1 Apr
    expect(at.toISOString().slice(0, 10)).toBe("2026-03-31");
    expect(istToday(at)).toBe("2026-04-01");
    expect(fyStartYear(at)).toBe(2026); // naya FY shuru ho chuka
  });

  it("the edges: 05:29:59 IST vs 18:30:00Z", () => {
    expect(istToday(new Date("2026-09-27T18:29:59Z"))).toBe("2026-09-27");
    expect(istToday(new Date("2026-09-27T18:30:00Z"))).toBe("2026-09-28");
    expect(istToday(new Date("2026-09-28T00:00:00Z"))).toBe("2026-09-28"); // 05:30 IST
  });

  it("matches Intl Asia/Kolkata hour by hour across a year", () => {
    const start = Date.parse("2026-01-01T00:00:00Z");
    for (let h = 0; h < 366 * 24; h += 7) {
      const d = new Date(start + h * 3_600_000);
      expect(toIstDate(d)).toBe(intlIst(d));
    }
  });

  it("istMonth / istParts", () => {
    const at = new Date("2026-09-30T19:00:00Z"); // 00:30 IST 1 Oct
    expect(istMonth(at)).toBe("2026-10");
    expect(istParts(at)).toMatchObject({ date: "2026-10-01", hour: 0, minute: 30, minutesOfDay: 30 });
  });
});

describe("calendar arithmetic", () => {
  it("addDaysISO crosses months, years and leap days", () => {
    expect(addDaysISO("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysISO("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysISO("2026-01-01", -1)).toBe("2025-12-31");
    expect(daysBetweenISO("2026-03-01", "2026-04-01")).toBe(31);
  });
  it("istDayStartUtc is 18:30Z the previous day", () => {
    expect(istDayStartUtc("2026-09-28").toISOString()).toBe("2026-09-27T18:30:00.000Z");
  });
});

describe("Indian FY (April–March)", () => {
  it.each([
    ["2026-03-31", 2025, "2025-26"],
    ["2026-04-01", 2026, "2026-27"],
    ["2099-12-31", 2099, "2099-00"],
  ])("%s → %i / %s", (iso, y, label) => {
    expect(fyStartYear(iso)).toBe(y);
    expect(fyLabel(iso)).toBe(label);
  });
  it("fyBounds", () => {
    expect(fyBounds("2026-09-28")).toEqual({ start: "2026-04-01", end: "2027-03-31", startYear: 2026 });
  });
});

describe("monthBounds", () => {
  it("February, leap and not, and December", () => {
    expect(monthBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28", nextStart: "2026-03-01" });
    expect(monthBounds("2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29", nextStart: "2028-03-01" });
    expect(monthBounds("2026-12")).toEqual({ start: "2026-12-01", end: "2026-12-31", nextStart: "2027-01-01" });
  });
});

describe("formatIstDate", () => {
  it("a date string is a calendar date; an instant is converted to IST first", () => {
    expect(formatIstDate("2026-09-05")).toBe("5 Sep 2026");
    expect(formatIstDate("2026-09-27T20:00:00Z")).toBe("28 Sep 2026");
    expect(formatIstDate(new Date("2026-03-31T20:30:00Z"))).toBe("1 Apr 2026");
  });
});

/* R-178: the dashboard greeting follows the IST clock, whatever the machine's timezone. */
describe("istGreeting", () => {
  it("06:15 UTC is 11:45 IST — morning, though the UTC hour says morning too", () => {
    expect(istGreeting(new Date("2026-10-06T06:15:00Z"))).toBe("Good morning");
  });
  it("06:30 UTC is 12:00 IST — afternoon (the server's getHours() said 6 → morning)", () => {
    expect(istGreeting(new Date("2026-10-06T06:30:00Z"))).toBe("Good afternoon");
  });
  it("11:30 UTC is 17:00 IST — evening", () => {
    expect(istGreeting(new Date("2026-10-06T11:30:00Z"))).toBe("Good evening");
  });
  it("20:00 UTC is 01:30 IST next day — morning (UTC hour 20 would say evening)", () => {
    expect(istGreeting(new Date("2026-10-06T20:00:00Z"))).toBe("Good morning");
  });
});
