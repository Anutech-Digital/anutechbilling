"use client";

/**
 * R-1436 — "Logins for attendance": the owner links each active employee to the login they
 * sign in with (users.employee_id), or unlinks it. Before this, a sales / support login saw
 * "Profile not linked" on /attendance/me and nobody could fix it without a DB edit.
 * Owner only — the DB guard (R-712) refuses every other role; nothing is fetched for them.
 */
import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useEmployees } from "@/lib/queries/payroll";
import { useLinkLogin, useTenantLogins } from "@/lib/queries/employee-login-link";
import {
  canLinkLogins,
  linkedLoginFor,
  loginChoicesFor,
  loginLabel,
  planLoginLink,
} from "@/lib/attendance/login-link";
import { toTitleCase } from "@/lib/utils";

export function EmployeeLoginsPanel() {
  const role = useCurrentUser().data?.role ?? null;
  const allowed = canLinkLogins(role);
  const loginsQ = useTenantLogins(allowed);
  const empQ = useEmployees();
  const link = useLinkLogin();

  if (!allowed) return null;

  const logins = loginsQ.data ?? [];
  const employees = (empQ.data ?? []).filter((e) => e.is_active);

  return (
    <Card id="logins" className="mt-6 p-4 md:p-5 scroll-mt-20">
      <h2 className="font-serif text-xl">Logins for attendance</h2>
      <p className="text-sm text-ink-3 mt-1">
        Link each employee to the login they sign in with. Once linked, they see their name and Check In on My
        attendance. One login per employee.
      </p>

      {loginsQ.isLoading || empQ.isLoading ? (
        <div className="mt-4 space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : loginsQ.error ? (
        <p className="mt-4 text-sm text-rose">Could not load your team&apos;s logins. Reload the page to try again.</p>
      ) : employees.length === 0 ? (
        <p className="mt-4 text-sm text-ink-3">Add an active employee above first, then link their login here.</p>
      ) : (
        <ul className="mt-4 divide-y divide-hairline">
          {employees.map((e) => {
            const name = toTitleCase(e.name);
            const linked = linkedLoginFor(e.id, logins);
            const choices = loginChoicesFor(e.id, logins);
            const selectId = `login-for-${e.id}`;
            return (
              <li key={e.id} className="py-3 flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
                <div className="min-w-0 md:w-1/3">
                  <label htmlFor={selectId} className="font-medium text-ink">{name}</label>
                  {e.email && <div className="text-xs font-mono text-ink-3 truncate">{e.email}</div>}
                </div>
                <div className="flex flex-1 items-center gap-2">
                  <select
                    id={selectId}
                    aria-label={`Login for ${name}`}
                    value={linked?.id ?? ""}
                    disabled={link.isPending}
                    onChange={(ev) =>
                      link.mutate({ employeeName: name, writes: planLoginLink(e.id, ev.target.value || null, logins) })
                    }
                    className="min-h-11 w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40 disabled:opacity-60"
                  >
                    <option value="">Not linked</option>
                    {choices.map((l) => (
                      <option key={l.id} value={l.id}>{loginLabel(l)}</option>
                    ))}
                  </select>
                  {linked && (
                    <Button
                      variant="default"
                      aria-label={`Unlink ${name}'s login`}
                      disabled={link.isPending}
                      onClick={() => link.mutate({ employeeName: name, writes: planLoginLink(e.id, null, logins) })}
                    >
                      Unlink
                    </Button>
                  )}
                </div>
                {!linked && choices.length === 0 && (
                  <p className="text-xs text-ink-3 md:w-1/4">
                    No free login — every login is already linked.{" "}
                    <Link href="/team" className="text-amber-ink underline">Invite on Team</Link>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
