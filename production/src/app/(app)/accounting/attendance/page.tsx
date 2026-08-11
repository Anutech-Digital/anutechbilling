/**
 * Attendance — the admin attendance register + office-network settings.
 * (The employee check-in kiosk lives separately at /attendance/kiosk.)
 * Split out of the old combined Payroll & Leave page.
 */
"use client";

import { Suspense } from "react";
import { AttendanceTab, HrPageShell } from "../payroll/screens";

export default function AttendancePage() {
  return (
    <HrPageShell
      title="Attendance Register"
      sub="Monthly attendance register + office-network settings. Employees check in at the Attendance Kiosk."
    >
      {/* AttendanceTab reads ?employee/?month via useSearchParams — Suspense-wrapped
          so the production build doesn't bail out of static rendering. */}
      <Suspense fallback={null}>
        <AttendanceTab />
      </Suspense>
    </HrPageShell>
  );
}
