/**
 * R-2428 — after a salary bank line is booked as a FULL & FINAL settlement, ask once:
 * "Start exit for <name>?" with the last working day = the payment date (the owner can move it).
 *
 * Staging Anutech, 3 Nov: Keshav Malik's F&F was booked on 16 Apr, nobody started his exit,
 * and salary records kept appearing for Jun–Sep. The exit is what stops payroll (R-1896).
 *
 * Owner only (start_employee_exit ends the person's login). Anyone else gets a one-line note
 * to ask the owner. Nothing shows when the employee already has an exit date.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { StartExitDialog } from "./start-exit-dialog";
import { useEmployees } from "@/lib/queries/payroll";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { formatDate, rupee } from "@/lib/utils";

export type FnfExitPromptInput = { employeeId: string; lastDay: string; amount: number };

export function FnfExitPrompt({ prompt, onClose }: { prompt: FnfExitPromptInput | null; onClose: () => void }) {
  /* isFetching too: an F&F that also CREATED the employee refetches the list — wait for it. */
  const { data: employees, isLoading, isFetching } = useEmployees();
  const me = useCurrentUser();
  const role = me.data?.role;
  const emp = prompt ? (employees ?? []).find((e) => e.id === prompt.employeeId) ?? null : null;
  const isOwner = role === "owner";
  const ready = !!prompt && !isLoading && !me.isLoading && (!!emp || !isFetching);

  React.useEffect(() => {
    if (!ready || !prompt) return;
    if (!emp || emp.exit_date) { onClose(); return; }
    if (!isOwner) {
      toast.info(`Full & final paid to ${emp.name} — ask the owner to start their exit (Payroll → Employees → ⋯ → Start exit).`);
      onClose();
    }
  }, [ready, prompt, emp, isOwner, onClose]);

  if (!ready || !prompt || !emp || emp.exit_date || !isOwner) return null;
  return (
    <StartExitDialog
      employee={emp}
      initialLastDay={prompt.lastDay}
      reasonText={`Full & final ${rupee(prompt.amount)} paid on ${formatDate(prompt.lastDay)}. Start ${emp.name}'s exit?`}
      onClose={onClose}
    />
  );
}
