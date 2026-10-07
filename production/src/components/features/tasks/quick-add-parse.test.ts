import { describe, it, expect } from "vitest";
import { parseQuickAdd } from "./quick-add-parse";
import { toIstDate, istParts } from "@/lib/dates/ist";

// Wed 7 Oct 2026, 10:00 IST
const NOW = new Date("2026-10-07T04:30:00Z");
const ist = (d: Date) => `${toIstDate(d)} ${String(istParts(d).hour).padStart(2, "0")}:${String(istParts(d).minute).padStart(2, "0")}`;

describe("R-354 parseQuickAdd", () => {
  it("Call Amit tomorrow 3 PM → call, 8 Oct 15:00 IST", () => {
    const p = parseQuickAdd("Call Amit tomorrow 3 PM", NOW);
    expect(p.title).toBe("Call Amit");
    expect(p.kind).toBe("call");
    expect(ist(p.dueAt)).toBe("2026-10-08 15:00");
    expect(p.understood).toEqual({ date: true, time: true });
  });

  it("aaj / kal / parso", () => {
    expect(ist(parseQuickAdd("Send quote aaj 4pm", NOW).dueAt)).toBe("2026-10-07 16:00");
    expect(ist(parseQuickAdd("Send quote kal", NOW).dueAt)).toBe("2026-10-08 18:00");
    expect(ist(parseQuickAdd("Send quote parso 11 am", NOW).dueAt)).toBe("2026-10-09 11:00");
  });

  it("minutes, 24h and 12 AM / 12 PM", () => {
    expect(ist(parseQuickAdd("Demo today at 3:30 pm", NOW).dueAt)).toBe("2026-10-07 15:30");
    expect(ist(parseQuickAdd("Demo today 15:45", NOW).dueAt)).toBe("2026-10-07 15:45");
    expect(ist(parseQuickAdd("Lunch today 12 PM", NOW).dueAt)).toBe("2026-10-07 12:00");
    expect(ist(parseQuickAdd("Backup tomorrow 12 am", NOW).dueAt)).toBe("2026-10-08 00:00");
  });

  it("weekday names — next occurrence; 'next' on the same day skips a week", () => {
    expect(ist(parseQuickAdd("Email Ravi friday", NOW).dueAt)).toBe("2026-10-09 18:00");
    expect(ist(parseQuickAdd("Email Ravi on mon 10 am", NOW).dueAt)).toBe("2026-10-12 10:00");
    expect(ist(parseQuickAdd("Review wednesday", NOW).dueAt)).toBe("2026-10-07 18:00");
    expect(ist(parseQuickAdd("Review next wed", NOW).dueAt)).toBe("2026-10-14 18:00");
    expect(parseQuickAdd("Email Ravi friday", NOW).kind).toBe("email");
  });

  it("short day names are not stolen from a title without on/next", () => {
    const p = parseQuickAdd("Call Sun Pharma", NOW);
    expect(p.title).toBe("Call Sun Pharma");
    expect(p.understood.date).toBe(false);
  });

  it("nothing understood → today 6 PM, flagged", () => {
    const p = parseQuickAdd("Follow up with Neha", NOW);
    expect(p.title).toBe("Follow up with Neha");
    expect(p.kind).toBe("followup");
    expect(ist(p.dueAt)).toBe("2026-10-07 18:00");
    expect(p.understood).toEqual({ date: false, time: false });
  });

  it("after 6 PM the default rolls to tomorrow 6 PM; a past time with no day → tomorrow", () => {
    const evening = new Date("2026-10-07T13:30:00Z"); // 19:00 IST
    expect(ist(parseQuickAdd("Follow up", evening).dueAt)).toBe("2026-10-08 18:00");
    expect(ist(parseQuickAdd("Call Amit 9 am", NOW).dueAt)).toBe("2026-10-08 09:00");
    expect(ist(parseQuickAdd("Call Amit 11 am", NOW).dueAt)).toBe("2026-10-07 11:00");
  });

  it("IST day boundary — 00:01 IST is already the next day", () => {
    const justAfterMidnight = new Date("2026-10-07T18:31:00Z"); // 8 Oct 00:01 IST
    expect(ist(parseQuickAdd("Call kal 10 am", justAfterMidnight).dueAt)).toBe("2026-10-09 10:00");
    const justBefore = new Date("2026-10-07T18:29:00Z"); // 7 Oct 23:59 IST
    expect(ist(parseQuickAdd("Call kal 10 am", justBefore).dueAt)).toBe("2026-10-08 10:00");
  });

  it("strips dangling words and keeps unknown words in the title", () => {
    expect(parseQuickAdd("Meet Raj at 5 pm", NOW).title).toBe("Meet Raj");
    expect(parseQuickAdd("Meet Raj at 5 pm", NOW).kind).toBe("meeting");
    expect(parseQuickAdd("Pay rent by tomorrow", NOW).title).toBe("Pay rent");
    expect(parseQuickAdd("  ", NOW).title).toBe("");
  });
});
