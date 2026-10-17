/**
 * Employees — team management (profiles, salary, documents, leave balance).
 * Split out of the old combined Payroll & Leave page. Renders the shared
 * EmployeesTab screen under a standard HR page shell.
 */
"use client";

import { EmployeesTab, HrPageShell } from "../payroll/screens";
import { EmployeeLoginsPanel } from "./employee-logins-panel";

export default function EmployeesPage() {
  return (
    <HrPageShell
      title="Employees"
      sub="Your team — profiles, salary, ID documents (Aadhaar / PAN / resume) and paid-leave balance."
    >
      <EmployeesTab />
      {/* R-1436: owner links each employee to a login so they can check in at /attendance/me. */}
      <EmployeeLoginsPanel />
    </HrPageShell>
  );
}
