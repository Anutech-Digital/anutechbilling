import { describe, expect, it } from "vitest";
import type { PostCallSignals } from "@/lib/ai/telecall";
import { canCallNow, istDayStart, MAX_ATTEMPTS, nextWorkingDayAt, outcomeFromCall, parseCallingList, staleCallAction } from "./coldcall";

describe("parseCallingList", () => {
  it("reads phone, name, company, city and DND; normalises numbers to +91", () => {
    const csv = [
      "Name,Company,City,Mobile,DND",
      "Pankaj,Pankaj Traders,Delhi,98100 00001,",
      '"Sharma, Rajesh",Sharma & Co,Noida,+91 98100 00002,Yes',
    ].join("\n");
    const r = parseCallingList(csv);
    expect(r.error).toBeNull();
    expect(r.rows).toEqual([
      { phone: "+919810000001", name: "Pankaj", company: "Pankaj Traders", city: "Delhi", dnd: false },
      { phone: "+919810000002", name: "Sharma, Rajesh", company: "Sharma & Co", city: "Noida", dnd: true },
    ]);
  });

  it("sets aside unreadable numbers by line and keeps a repeated number once", () => {
    const r = parseCallingList("Phone\n9810000001\n12345\n09810000001\n");
    expect(r.rows.map((x) => x.phone)).toEqual(["+919810000001"]);
    expect(r.invalidLines).toEqual([3]);
    expect(r.duplicates).toBe(1);
  });

  it("refuses a file with no phone column, and says what to rename", () => {
    expect(parseCallingList("Name,Company\nA,B").error).toMatch(/phone column/i);
    expect(parseCallingList("").error).toMatch(/empty/i);
  });
});

const base: PostCallSignals = {
  disposition: "completed", durationSec: 60, transcript: "", summary: "",
  customerAskedForQuote: false, customerAskedForCallback: false,
  customerConfirmedRenewal: false, customerNotInterested: false, seatsDiscussed: null,
};
const now = new Date("2026-10-19T06:00:00Z");

describe("outcomeFromCall", () => {
  it("quote asked or users said → interested; not interested wins over both", () => {
    expect(outcomeFromCall({ ...base, customerAskedForQuote: true }, 1, now).status).toBe("interested");
    expect(outcomeFromCall({ ...base, seatsDiscussed: 10 }, 1, now).status).toBe("interested");
    expect(outcomeFromCall({ ...base, customerAskedForQuote: true, customerNotInterested: true }, 1, now).status).toBe("not_interested");
    expect(outcomeFromCall({ ...base, customerAskedForCallback: true }, 1, now).status).toBe("callback");
    expect(outcomeFromCall(base, 1, now).status).toBe("answered");
  });

  it("no answer / busy → retried about a day later, until the attempts run out", () => {
    const first = outcomeFromCall({ ...base, disposition: "no-answer" }, 1, now);
    expect(first.status).toBe("pending");
    expect(first.nextAttemptAt?.getTime()).toBe(now.getTime() + 20 * 3_600_000);
    expect(outcomeFromCall({ ...base, disposition: "busy" }, 2, now).status).toBe("pending");
    expect(outcomeFromCall({ ...base, disposition: "no-answer" }, MAX_ATTEMPTS, now))
      .toEqual({ status: "no_answer", nextAttemptAt: null });
    expect(outcomeFromCall({ ...base, disposition: "error" }, 1, now).status).toBe("failed");
  });
});

describe("calling window (IST, Mon–Fri)", () => {
  it("allows 10:00–17:59 IST on a weekday only", () => {
    // Mon 19 Oct 2026: 04:30Z = 10:00 IST, 12:29Z = 17:59 IST, 12:30Z = 18:00 IST.
    expect(canCallNow(new Date("2026-10-19T04:30:00Z"), 10, 18)).toBe(true);
    expect(canCallNow(new Date("2026-10-19T04:29:00Z"), 10, 18)).toBe(false);
    expect(canCallNow(new Date("2026-10-19T12:29:00Z"), 10, 18)).toBe(true);
    expect(canCallNow(new Date("2026-10-19T12:30:00Z"), 10, 18)).toBe(false);
    // Sun 18 Oct 2026, 12:00 IST.
    expect(canCallNow(new Date("2026-10-18T06:30:00Z"), 10, 18)).toBe(false);
  });

  it("the day starts at midnight IST", () => {
    expect(istDayStart(new Date("2026-10-19T06:00:00Z")).toISOString()).toBe("2026-10-18T18:30:00.000Z");
    expect(istDayStart(new Date("2026-10-18T19:00:00Z")).toISOString()).toBe("2026-10-18T18:30:00.000Z");
  });
});

describe("nextWorkingDayAt", () => {
  it("Tuesday → Wednesday 11:00 IST", () => {
    // Tue 20 Oct 2026 15:00 IST
    const d = nextWorkingDayAt(new Date("2026-10-20T09:30:00Z"), 11);
    expect(d.toISOString()).toBe("2026-10-21T05:30:00.000Z");
  });
  it("Friday → Monday", () => {
    // Fri 23 Oct 2026 17:00 IST
    const d = nextWorkingDayAt(new Date("2026-10-23T11:30:00Z"), 11);
    expect(d.toISOString()).toBe("2026-10-26T05:30:00.000Z");
  });
  it("late Saturday night UTC that is already Sunday IST → Monday", () => {
    // Sat 24 Oct 2026 20:00 UTC = Sun 01:30 IST
    const d = nextWorkingDayAt(new Date("2026-10-24T20:00:00Z"), 11);
    expect(d.toISOString()).toBe("2026-10-26T05:30:00.000Z");
  });
});

describe("staleCallAction — rows stuck on 'calling'", () => {
  const now = new Date("2026-10-20T08:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  it("claimed but never placed (server stopped mid-tick) → back in the queue after 10 min", () => {
    expect(staleCallAction({ providerCallId: null, lastCalledAt: ago(5) }, now)).toBe("wait");
    expect(staleCallAction({ providerCallId: null, lastCalledAt: ago(11) }, now)).toBe("requeue");
  });
  it("placed but the agent never reported → given up after 45 min", () => {
    expect(staleCallAction({ providerCallId: "x", lastCalledAt: ago(30) }, now)).toBe("wait");
    expect(staleCallAction({ providerCallId: "x", lastCalledAt: ago(46) }, now)).toBe("give_up");
  });
});
