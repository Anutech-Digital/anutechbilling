"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { openHelpReport } from "@/components/shared/ai-help";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useMyEmployeeLinkChoices, useSetMyEmployee } from "@/lib/queries/my-attendance";
import {
  canPickEmployee,
  linkCardMode,
  noEmployeesReason,
  EMPLOYEES_HREF,
  NO_EMPLOYEES_MESSAGE,
  NOT_LINKED_MESSAGE,
} from "@/lib/attendance/self-profile";

/** The one-time "link your login to an employee" card on /attendance/me.
 *  R-1001: names come from my_employee_link_choices() — employees itself is owner / manager /
 *  accountant only. R-1414: only those three roles get the picker; any other role sees a
 *  "not linked" card with Report a problem (no in-app link screen yet — R-1436), and a picker
 *  role with nothing to pick sees why plus Open Employees — never an empty dropdown. */
export function LinkEmployeeCard() {
  const userQ = useCurrentUser();
  const role = userQ.data?.role ?? null;
  const empQ = useMyEmployeeLinkChoices(canPickEmployee(role));
  const setEmp = useSetMyEmployee();
  const [selectedId, setSelectedId] = React.useState<string>("");

  const rows = empQ.data ?? [];
  const mode = linkCardMode(role, rows.length);

  if (userQ.isLoading) return <Skeleton className="h-48 w-full rounded-xl" />;

  if (mode === "ask-owner") {
    return (
      <Card className="p-6 md:p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-soft">
          <Icon name="user" className="h-6 w-6 text-amber-ink" />
        </div>
        <h2 className="font-serif text-xl">Profile not linked</h2>
        <p className="text-sm text-ink-3 mt-2">{NOT_LINKED_MESSAGE}</p>
        <Button icon="bug" className="mt-4" onClick={() => openHelpReport()}>
          Report a problem
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-6 md:p-8 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-soft">
        <Icon name="user" className="h-6 w-6 text-amber-ink" />
      </div>
      <h2 className="font-serif text-xl">Select your profile</h2>
      <p className="text-sm text-ink-3 mt-1">
        First time here — pick your name from the list. Once linked, you will not be asked again.
      </p>

      {empQ.isLoading ? (
        <Skeleton className="mt-5 h-10 w-full rounded-md" />
      ) : empQ.error ? (
        <p className="mt-4 text-xs text-rose">Could not load employees.</p>
      ) : mode === "no-employees" ? (
        <div className="mt-4 space-y-2 text-sm">
          <p className="font-medium text-ink">{NO_EMPLOYEES_MESSAGE}</p>
          <p className="text-ink-3">{noEmployeesReason(userQ.data?.authEmail)}</p>
          <Link href={EMPLOYEES_HREF} className="inline-block text-amber-ink underline">
            Open Employees
          </Link>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select your name…" />
            </SelectTrigger>
            <SelectContent>
              {rows.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            className="w-full"
            disabled={!selectedId || setEmp.isPending}
            onClick={() => setEmp.mutate(selectedId)}
          >
            {setEmp.isPending ? "Linking…" : "Save & Continue"}
          </Button>
        </div>
      )}
    </Card>
  );
}
