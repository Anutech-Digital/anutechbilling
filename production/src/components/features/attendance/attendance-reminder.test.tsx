// @vitest-environment jsdom
//
// The decision rules are covered in lib/attendance/reminders.test.ts. What is checked
// here is the thing those cannot see: that the component actually renders when a punch
// is outstanding, renders NOTHING when it is not, and that dismissing writes a per-day
// key so the popup stays gone for the rest of the day and comes back tomorrow.
//
// This exists because the popup could not be observed in the browser during the session
// that built it — the app was open at 02:39 IST, which is before the 06:00 check-in
// window, so the correct behaviour was to show nothing. Waiting until morning is not a
// test; this is.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const push = vi.fn();
let pathname = "/dashboard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}));

const currentUser = { data: { userId: "user-1" } };
const today: { data: unknown } = { data: null };
const prefs: { data: unknown } = { data: null };
/* Working by default, so every existing case behaves as it did. The Sunday case sets
   this and asserts nothing renders. */
const workingDay: { data: { working: boolean; reason: string | null } } = {
  data: { working: true, reason: null },
};

vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => currentUser }));
vi.mock("@/lib/queries/my-attendance", () => ({
  useMyAttendanceToday: () => today,
  useMyReminderPrefs: () => prefs,
  useTodayWorkingDay: () => workingDay,
}));

import { AttendanceReminder } from "./attendance-reminder";
import { dismissKey } from "@/lib/attendance/reminders";

/** Freeze the clock at a chosen IST wall time. 04:30Z === 10:00 IST. */
function atIst(utcIso: string) {
  vi.setSystemTime(new Date(utcIso));
}

/**
 * A localStorage stand-in.
 *
 * jsdom in this project does not expose one, and the component deliberately treats
 * storage as something that can be absent or throw (private mode) rather than assuming
 * it. Supplying an explicit store keeps the dismissal assertions readable and does not
 * depend on how the test environment happens to be configured today.
 */
const store = new Map<string, string>();
const memoryStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
} as Storage;

Object.defineProperty(window, "localStorage", { value: memoryStorage, configurable: true });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  push.mockClear();
  pathname = "/dashboard";
  window.localStorage.clear();
  today.data = { linked: true, check_in: null, check_out: null };
  prefs.data = { enabled: true, checkoutAt: "18:00:00" };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AttendanceReminder", () => {
  it("asks for a check-in during the day when none has happened", () => {
    atIst("2026-08-19T04:30:00Z"); // 10:00 IST
    render(<AttendanceReminder />);
    expect(screen.getByText(/You haven.t checked in yet/)).toBeDefined();
  });

  it("renders nothing before the check-in window opens", () => {
    // 21:00Z on the 18th is 02:30 IST on the 19th — exactly the state the browser was
    // in when this was built, and the reason a component test was needed at all.
    atIst("2026-08-18T21:00:00Z");
    render(<AttendanceReminder />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks for a check-out after the configured time when one is outstanding", () => {
    today.data = { linked: true, check_in: "2026-08-19T04:00:00Z", check_out: null };
    atIst("2026-08-19T13:00:00Z"); // 18:30 IST
    render(<AttendanceReminder />);
    expect(screen.getByText(/You haven.t checked out yet/)).toBeDefined();
  });

  it("renders nothing once both punches exist", () => {
    today.data = { linked: true, check_in: "2026-08-19T04:00:00Z", check_out: "2026-08-19T13:00:00Z" };
    atIst("2026-08-19T14:00:00Z");
    render(<AttendanceReminder />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays out of the way on the attendance screen itself", () => {
    pathname = "/attendance/me";
    atIst("2026-08-19T04:30:00Z");
    render(<AttendanceReminder />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing when the person switched reminders off", () => {
    prefs.data = { enabled: false, checkoutAt: "18:00:00" };
    atIst("2026-08-19T04:30:00Z");
    render(<AttendanceReminder />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends the person to the attendance page rather than punching for them", () => {
    // No check-in happens here on purpose: the real punch can need a selfie, consent, a
    // presence code and a face match. A second path that skips those is a way to mark
    // attendance from home.
    atIst("2026-08-19T04:30:00Z");
    render(<AttendanceReminder />);
    fireEvent.click(screen.getByText(/Open attendance/));
    expect(push).toHaveBeenCalledWith("/attendance/me");
  });

  it("does not mark itself done when the person navigates to punch", () => {
    // If they get distracted on the way, the reminder must still be waiting — otherwise
    // it loses the exact punch it exists to catch.
    atIst("2026-08-19T04:30:00Z");
    render(<AttendanceReminder />);
    fireEvent.click(screen.getByText(/Open attendance/));
    expect(window.localStorage.getItem(dismissKey("user-1", "check_in"))).toBeNull();
  });

  it("remembers a dismissal for the rest of that IST day", () => {
    atIst("2026-08-19T04:30:00Z");
    const view = render(<AttendanceReminder />);
    fireEvent.click(screen.getByText(/Not today/));
    expect(window.localStorage.getItem(dismissKey("user-1", "check_in"))).toBe("2026-08-19");
    expect(view.queryByRole("dialog")).toBeNull();
  });

  it("comes back the next day after a dismissal", () => {
    window.localStorage.setItem(dismissKey("user-1", "check_in"), "2026-08-19");
    atIst("2026-08-20T04:30:00Z"); // next morning, 10:00 IST
    render(<AttendanceReminder />);
    expect(screen.getByText(/You haven.t checked in yet/)).toBeDefined();
  });

  it("renders nothing while the preferences are still loading", () => {
    // A popup that flashes up before its own settings arrive would ignore somebody who
    // had switched it off.
    prefs.data = null;
    atIst("2026-08-19T04:30:00Z");
    render(<AttendanceReminder />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing for a login with no employee record", () => {
    today.data = { linked: false };
    atIst("2026-08-19T04:30:00Z");
    render(<AttendanceReminder />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a day the company is closed", () => {
  /* Reported 23 Aug 2026 — a Sunday — as "aaj kya attendance reminder ko aana chahiye
     kya ye logical hai". It should not. The push cron and this popup share
     decideAttendanceReminder precisely so they cannot disagree about the same day, so
     the popup needs the same working-day answer the cron resolves server-side. */
  beforeEach(() => {
    atIst("2026-08-19T04:30:00Z"); // 10:00 IST, a Wednesday — the day is set by the mock below
    today.data = { linked: true, check_in: null, check_out: null };
    prefs.data = { enabled: true, checkoutAt: "18:00" };
  });

  it("renders nothing on a weekly off, even with a check-in outstanding", () => {
    workingDay.data = { working: false, reason: "Sunday is a weekly off." };
    render(<AttendanceReminder />);
    expect(screen.queryByText(/check.?in/i)).toBeNull();
  });

  it("renders nothing on a company holiday", () => {
    workingDay.data = { working: false, reason: "2026-10-20 is a company holiday." };
    render(<AttendanceReminder />);
    expect(screen.queryByText(/check.?in/i)).toBeNull();
  });

  it("still renders on a working day — the no-regression half", () => {
    /* Saturday is a working day here, so silencing too much would be the worse bug: a
       missing check-in nobody was reminded about becomes a payroll query. */
    workingDay.data = { working: true, reason: null };
    render(<AttendanceReminder />);
    expect(screen.queryByText(/check.?in/i)).not.toBeNull();
  });

  /* R-319: the popup came up in Hinglish on the Subscriptions page. In-app copy is plain
     English (chat stays Hinglish). These words were in the old copy; none may come back. */
  const HINGLISH = /\b(karna|reh gaya|kholo|karo|aaj|nahi|baad|baaki|abhi|ho jayega|band|kar sakte|adhoora|aap)\b/i;

  it.each([
    ["check-in", null, "2026-08-19T04:30:00Z"],
    ["check-out", "2026-08-19T04:00:00Z", "2026-08-19T13:00:00Z"],
  ])("shows the %s popup in plain English", (_label, checkIn, at) => {
    workingDay.data = { working: true, reason: null };
    today.data = { linked: true, check_in: checkIn, check_out: null };
    atIst(at);
    render(<AttendanceReminder />);
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text.length).toBeGreaterThan(20);
    expect(text).not.toMatch(HINGLISH);
  });
});
