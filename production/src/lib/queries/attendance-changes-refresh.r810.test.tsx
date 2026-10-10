// @vitest-environment jsdom
/* R-810 — after an owner's "Fix attendance" Save (or Mark absent), the "Changes by staff"
   list (R-608) refreshes at once instead of only after a page reload: its query key sits
   under ["attendance"], which every attendance save invalidates. */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: h.rpc }) }));

import { useCorrectAttendance } from "@/lib/queries/payroll";
import { ATTENDANCE_CHANGES_KEY } from "@/lib/attendance/change-log";

afterEach(() => { cleanup(); h.rpc.mockReset(); });

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  qc.setQueryData(ATTENDANCE_CHANGES_KEY, [{ id: 1 }]);
  qc.setQueryData(["attendance", "2026-10"], []);
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, ...renderHook(() => useCorrectAttendance(), { wrapper }) };
}

describe("R-810 Changes by staff refreshes after an attendance save", () => {
  it("the list key sits under ['attendance'], the key every attendance save invalidates", () => {
    expect(ATTENDANCE_CHANGES_KEY[0]).toBe("attendance");
  });

  it("Fix attendance Save invalidates the Changes by staff list", async () => {
    h.rpc.mockResolvedValue({ data: "saved", error: null });
    const { qc, result } = setup();
    expect(qc.getQueryState(ATTENDANCE_CHANGES_KEY)?.isInvalidated).toBe(false);
    act(() => result.current.mutate({
      employeeId: "e1", workDate: "2026-10-05",
      checkIn: "2026-10-05T04:30:00Z", checkOut: "2026-10-05T12:30:00Z", note: "Forgot to check out",
    }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.rpc).toHaveBeenCalledWith("correct_attendance", expect.objectContaining({ p_employee_id: "e1" }));
    expect(qc.getQueryState(ATTENDANCE_CHANGES_KEY)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["attendance", "2026-10"])?.isInvalidated).toBe(true);
  });

  it("a failed save leaves the list alone", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "nope" } });
    const { qc, result } = setup();
    act(() => result.current.mutate({ employeeId: "e1", workDate: "2026-10-05", checkIn: null, checkOut: null, note: "x" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryState(ATTENDANCE_CHANGES_KEY)?.isInvalidated).toBe(false);
  });
});
