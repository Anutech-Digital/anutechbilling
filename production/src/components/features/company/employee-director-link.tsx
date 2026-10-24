/**
 * R-1852 — Employees → an employee's profile → "Director of the company?".
 *
 * A whole-time / managing director who draws a salary is paid through Payroll (TDS on salary,
 * s.192). Linking the employee to a director in the directors register (R-1850) makes the P&L show
 * that payroll as Director's Remuneration, apart from Salaries (lib/accounting/director-remuneration.ts).
 * Only a Pvt Ltd (empty type = Pvt Ltd) and the register's roles (owner, manager, accountant) see it.
 * No directors yet → a link to add them in Settings → Company.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useComplianceProfile } from "@/lib/compliance/profile";
import { showsDirectorsRegister, isActiveDirector, DESIGNATION_LABEL } from "@/lib/company/directors";
import { useCompanyDirectors, useSetDirectorEmployee } from "@/lib/queries/company-directors";
import { istToday } from "@/lib/dates/ist";

const REGISTER_ROLES = new Set(["owner", "manager", "accountant"]);

export function EmployeeDirectorLink({ employeeId }: { employeeId: string }) {
  const me = useCurrentUser();
  const profile = useComplianceProfile();
  const allowed = REGISTER_ROLES.has(me.data?.role ?? "") && profile.isSuccess && showsDirectorsRegister(profile.data?.businessType);
  const directorsQ = useCompanyDirectors(allowed);
  const setLink = useSetDirectorEmployee();
  if (!allowed || !directorsQ.data) return null;

  const today = istToday();
  const directors = directorsQ.data;
  const linked = directors.find((d) => d.employee_id === employeeId) ?? null;
  /* A director already paid as ANOTHER employee is not offered (one employee, one director). */
  const choices = directors.filter((d) => isActiveDirector(d, today) && (!d.employee_id || d.employee_id === employeeId));

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    if (id === (linked?.id ?? "")) return;
    if (!id) {
      if (linked) setLink.mutate({ directorId: linked.id, employeeId: null });
      return;
    }
    setLink.mutate({ directorId: id, employeeId, previousDirectorId: linked?.id ?? null });
  }

  return (
    <div className="rounded-md border border-hairline bg-paper-2/30 p-3 space-y-1.5" data-testid="employee-director-link">
      <label htmlFor="emp-director" className="text-xs font-semibold text-ink-2">Director of the company?</label>
      {directors.length === 0 ? (
        <p className="text-xs text-ink-3">
          No directors in the register yet. <Link href="/settings/company" className="text-amber-ink underline">Add them in Settings → Company</Link>.
        </p>
      ) : (
        <>
          <select
            id="emp-director"
            value={linked?.id ?? ""}
            onChange={onChange}
            disabled={setLink.isPending}
            className="w-full h-9 rounded-md border border-hairline bg-paper px-2 text-sm text-ink"
          >
            <option value="">Not a director</option>
            {choices.map((d) => (
              <option key={d.id} value={d.id}>{d.name} — {DESIGNATION_LABEL[d.designation]} (DIN {d.din})</option>
            ))}
          </select>
          <p className="text-xs text-ink-3 leading-relaxed">
            {linked
              ? "Payroll pays this salary with TDS on salary (section 192); the P&L shows it as Director's Remuneration, apart from Salaries."
              : "Pick the director if this employee is a whole-time or managing director — the P&L then shows their salary as Director's Remuneration."}
          </p>
        </>
      )}
    </div>
  );
}
