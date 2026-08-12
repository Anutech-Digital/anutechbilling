"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateTask } from "@/lib/queries/tasks";

export type LeaveType = "cl" | "sl" | "wfh" | "regularization";

export interface LeaveRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeName?: string;
}

export function LeaveRequestDialog({
  open,
  onOpenChange,
  employeeName = "Employee",
}: LeaveRequestDialogProps) {
  const createTask = useCreateTask();
  const [leaveType, setLeaveType] = React.useState<LeaveType>("cl");
  const [fromDate, setFromDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [toDate, setToDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = React.useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      toast.error("Kripya reason enter karein.");
      return;
    }

    try {
      const typeLabel =
        leaveType === "cl" ? "Casual Leave (CL)" :
        leaveType === "sl" ? "Sick Leave (SL)" :
        leaveType === "wfh" ? "Work From Home (WFH)" : "Punch Regularization";

      await createTask.mutateAsync({
        title: `Leave/Regularization Request: ${typeLabel} - ${employeeName}`,
        notes: `Requested by ${employeeName} from ${fromDate} to ${toDate}.\nReason: ${reason}`,
        status: "pending",
        due_at: new Date(toDate + "T18:00:00.000Z").toISOString(),
      });

      toast.success(`${typeLabel} request submitted to manager for approval!`);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || "Could not submit request");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-paper border border-hairline p-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-serif">
            <Icon name="calendar" size={20} className="text-amber-ink" />
            Apply Leave / Regularization
          </DialogTitle>
          <DialogDescription className="text-xs text-ink-3">
            Submit leave or missed punch correction for manager approval.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 my-2">
          {/* Request Type */}
          <div>
            <Label className="text-xs font-semibold text-ink-2 mb-1.5 block">Request Type:</Label>
            <Select value={leaveType} onValueChange={(v) => setLeaveType(v as LeaveType)}>
              <SelectTrigger className="w-full text-xs bg-paper">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cl">🌴 Casual Leave (CL)</SelectItem>
                <SelectItem value="sl">🤒 Sick Leave (SL)</SelectItem>
                <SelectItem value="wfh">🏠 Work From Home (WFH)</SelectItem>
                <SelectItem value="regularization">⏰ Punch Regularization (Missed Punch)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Date Range */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-semibold text-ink-2 mb-1.5 block">From Date:</Label>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="text-xs bg-paper"
              />
            </div>
            <div>
              <Label className="text-xs font-semibold text-ink-2 mb-1.5 block">To Date:</Label>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="text-xs bg-paper"
              />
            </div>
          </div>

          {/* Reason */}
          <div>
            <Label className="text-xs font-semibold text-ink-2 mb-1.5 block">Reason / Details:</Label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Provide reason or client meeting details..."
              className="w-full text-xs font-mono p-2.5 rounded-md border border-hairline bg-paper-2/60 focus:bg-paper focus:outline-none focus:ring-1 focus:ring-amber text-ink"
            />
          </div>

          <DialogFooter className="pt-2 border-t border-hairline flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={createTask.isPending}
              className="gap-1.5"
            >
              <Icon name="check_circle" size={14} />
              {createTask.isPending ? "Submitting..." : "Submit for Approval"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
