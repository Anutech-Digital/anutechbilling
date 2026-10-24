// @vitest-environment jsdom
/**
 * R-1471 — /attendance/me must hydrate cleanly (React #418 = server HTML ≠ client render).
 *
 * The only time-dependent text in the server HTML of this page is the "Thursday, 16 October"
 * line under the title. It used to come from Intl (`toLocaleDateString("en-IN")`), whose output
 * differs between ICU builds (Cloud Run's Node vs the browser), so the hydrated text never
 * matched. The label is now plain arithmetic in IST; this test pins the fixed-clock output and
 * server-renders + hydrates the page asserting React logs no hydration error.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { act } from "react";

const state = vi.hoisted(() => ({
  today: { data: undefined as unknown, isLoading: true, error: null as unknown },
}));
const noMutation = vi.hoisted(() => () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }));

vi.mock("@/lib/queries/payroll", () => ({
  useAttendanceNetwork: () => ({ data: undefined, isLoading: true, error: null }),
}));
vi.mock("@/lib/queries/my-attendance", () => ({
  useMyAttendanceToday: () => state.today,
  useMarkSelfAttendance: noMutation,
  useMyAttendanceHistory: () => ({ data: undefined, isLoading: true, error: null }),
  useRecordConsent: noMutation,
  useWithdrawConsent: noMutation,
  useEnrollMyFace: noMutation,
  useUndoLastPunch: noMutation,
  useMyReminderPrefs: () => ({ data: undefined, isLoading: true, error: null }),
  useSetMyReminderPrefs: noMutation,
}));
vi.mock("@/lib/queries/attendance-shift", () => ({
  useShiftRules: () => ({ data: undefined, isLoading: true, error: null }),
}));
vi.mock("@/lib/attendance/device", () => ({ getDeviceToken: () => "" }));
vi.mock("./device-card", () => ({
  ThisDeviceCard: () => null,
  useDeviceSignature: () => ({ sign: vi.fn(), signing: false, hint: null }),
}));
vi.mock("./link-employee-card", () => ({ LinkEmployeeCard: () => <div>link-card</div> }));
vi.mock("@/components/features/attendance/leave-request-dialog", () => ({
  LeaveRequestDialog: () => null,
}));

import MyAttendancePage from "./page";
import { todayLabel } from "./today-label";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let errors: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  // 16 Oct 2026 10:30 IST (05:00Z) — a Friday in IST.
  vi.setSystemTime(new Date("2026-10-16T05:00:00Z"));
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("todayLabel (IST, no Intl)", () => {
  it("formats a fixed clock as 'Weekday, D Month' in IST", () => {
    expect(todayLabel(new Date("2026-10-16T05:00:00Z"))).toBe("Friday, 16 October");
  });
  it("rolls to the next day at IST midnight even when UTC has not", () => {
    // 18:30Z = 00:00 IST next day.
    expect(todayLabel(new Date("2026-10-16T18:30:00Z"))).toBe("Saturday, 17 October");
    expect(todayLabel(new Date("2026-10-16T18:29:59Z"))).toBe("Friday, 16 October");
  });
  it("is deterministic between two calls on the same clock (server vs client)", () => {
    expect(todayLabel()).toBe(todayLabel());
    expect(todayLabel()).toBe("Friday, 16 October");
  });
});

describe("/attendance/me hydration", () => {
  it("server HTML hydrates without a React hydration error", async () => {
    const html = renderToString(<MyAttendancePage />);
    expect(html).toContain("Friday, 16 October");
    expect(html).toContain("My Attendance");

    container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    await act(async () => {
      root = hydrateRoot(container!, <MyAttendancePage />, {
        onRecoverableError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
      });
    });

    const hydration = errors.filter((m) => /418|hydrat|did not match|mismatch/i.test(m));
    expect(hydration).toEqual([]);
    expect(container.textContent).toContain("Friday, 16 October");
  });
});
