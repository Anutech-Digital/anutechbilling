/**
 * Leave — record & track employee leave and loss-of-pay (LOP).
 * Split out of the old combined Payroll & Leave page.
 */
"use client";

import { LeaveTab, HrPageShell } from "../payroll/screens";

export default function LeavePage() {
  return (
    <HrPageShell
      title="Leave Register"
      sub="Record leave and loss-of-pay. Unpaid leave becomes LOP in that month's payroll."
    >
      <LeaveTab />
    </HrPageShell>
  );
}
