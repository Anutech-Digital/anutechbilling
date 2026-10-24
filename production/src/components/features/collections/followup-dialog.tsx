/**
 * R-1517 — "Follow-up" dialog: log a call / WhatsApp / email / meeting / note / promise-to-pay
 * for one customer, set the NEXT follow-up date (required, default +3 days IST) and, for
 * owner / manager / accountant only, who it is with. The customer's history sits underneath.
 *
 * Opened from each /collections row and from the customer page's Payment follow-up card.
 * Phone: DialogContent is a bottom sheet (§20). Form: RHF + Zod (§9), rules shared with the
 * API route (lib/collections/followup-rules.ts). Save → POST /api/collections/followups, which
 * re-checks the reassign rule on the server; the list and history refresh at once (§10).
 * A refused save stays in the dialog with what happened and what to do next (§24).
 */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { describeError } from "@/lib/errors/toast-error";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useUserNames } from "@/lib/hooks/useUserNames";
import { istToday } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";
import {
  buildFollowupHistory, defaultAssignee, defaultNextFollowUp, FOLLOWUP_KIND_LABEL, FOLLOWUP_KINDS,
  followupFormSchema, linkOptions, mayReassignFollowup, toFollowupRequest,
  type FollowupFormData, type FollowupLinkSource, type PromisePayment,
} from "@/lib/collections/followup-rules";
import { FollowupSaveError, useAddFollowup, useCustomerFollowups } from "@/lib/queries/payment-followups";
import { FollowupHistory } from "./followup-history";

const SELECT_CLS = "w-full min-h-[44px] md:min-h-0 rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber";

export interface FollowupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
  /** customers.account_manager_id. */
  ownerId: string | null;
  /** What the customer owes — offered as "About" links. */
  items: readonly FollowupLinkSource[];
  /** The customer still owes money (a past promise is then broken). */
  stillOwes: boolean;
  /** R-1540: this customer's received payments (CollectionRow.payments) — what keeps a promise. */
  payments?: readonly PromisePayment[];
  amountDue?: number;
  /** R-1518: switch to the Remind dialog (AI-drafted reminder a person sends). Absent → no button. */
  onRemind?: () => void;
}

/** §24: the API's own sentence shows as written; database plumbing becomes plain words + next step. */
function errorText(err: unknown): string {
  const d = describeError(err);
  return d.description ? `${d.message} ${d.description}` : d.message;
}

export function FollowupDialog({ open, onOpenChange, customerId, customerName, ownerId, items, stillOwes, payments, amountDue, onRemind }: FollowupDialogProps) {
  const { data: me } = useCurrentUser();
  const { data: names } = useUserNames();
  const history = useCustomerFollowups(open ? customerId : null);
  const add = useAddFollowup();
  const [serverError, setServerError] = React.useState<{ message: string; status: number } | null>(null);

  const today = istToday();
  const canReassign = mayReassignFollowup(me?.role);
  const links = React.useMemo(() => linkOptions(items), [items]);
  const entries = React.useMemo(() => buildFollowupHistory(history.data ?? [], today, stillOwes, payments), [history.data, today, stillOwes, payments]);
  const assigneeDefault = defaultAssignee({ latestAssignedTo: entries[0]?.assigned_to, ownerId, meId: me?.userId });
  const team = React.useMemo(
    () => [...(names?.values() ?? [])].filter((u) => !u.inactive || u.id === assigneeDefault).sort((a, b) => a.label.localeCompare(b.label)),
    [names, assigneeDefault],
  );
  const nameOf = (id: string | null) => (id ? names?.get(id)?.label ?? "a colleague" : "nobody yet");

  const blank = React.useCallback((): FollowupFormData => ({
    kind: "call",
    note: undefined,
    promisedAmount: undefined,
    promisedOn: undefined,
    nextFollowUpOn: defaultNextFollowUp(istToday()),
    assignedTo: undefined,
    link: links.length === 1 ? links[0].value : "",
  }), [links]);

  const form = useForm<FollowupFormData>({ resolver: zodResolver(followupFormSchema), defaultValues: blank() });
  const { register, handleSubmit, reset, watch, setValue, getFieldState, formState: { errors } } = form;

  React.useEffect(() => {
    if (open) { reset(blank()); setServerError(null); }
    // Only on open: a later re-render must not wipe what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The default person is known once the history arrives — fill it unless someone picked.
  React.useEffect(() => {
    if (open && !getFieldState("assignedTo").isDirty) setValue("assignedTo", assigneeDefault ?? "");
  }, [open, assigneeDefault, getFieldState, setValue]);

  const kind = watch("kind");

  const onSubmit = (data: FollowupFormData) => {
    setServerError(null);
    add.mutate(toFollowupRequest(data, { customerId, links, canReassign }), {
      onSuccess: () => onOpenChange(false),
      onError: (e) => setServerError({
        message: e instanceof FollowupSaveError ? e.message : "The follow-up was not saved — press Save again.",
        status: e instanceof FollowupSaveError ? e.status : 0,
      }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Follow-up · {customerName}</DialogTitle>
          <DialogDescription>
            {amountDue && amountDue > 0 ? <>Still owes <b className="text-ink">{rupee(amountDue)}</b>. </> : null}
            Log what happened and when to follow up next — every entry needs a next date, so nobody is forgotten.
          </DialogDescription>
          {onRemind && stillOwes && (
            <div>
              <Button type="button" size="sm" variant="default" icon="send" className="mt-2" onClick={onRemind}>
                Draft a reminder (WhatsApp / email)
              </Button>
            </div>
          )}
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="What happened" required htmlFor="fu-kind">
              <select id="fu-kind" className={SELECT_CLS} {...register("kind")}>
                {FOLLOWUP_KINDS.map((k) => <option key={k} value={k}>{FOLLOWUP_KIND_LABEL[k]}</option>)}
              </select>
            </FormField>
            <FormField label="Next follow-up" required htmlFor="fu-next">
              <Input id="fu-next" type="date" min={today} error={errors.nextFollowUpOn?.message} {...register("nextFollowUpOn")} />
            </FormField>
          </div>

          {kind === "promise" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-md border border-hairline bg-paper-2/40 p-3">
              <FormField label="Will pay on" required htmlFor="fu-promised-on">
                <Input id="fu-promised-on" type="date" error={errors.promisedOn?.message} {...register("promisedOn")} />
              </FormField>
              <FormField label="Amount promised (₹, optional)" htmlFor="fu-promised-amount">
                <Input
                  id="fu-promised-amount" type="number" inputMode="numeric" min={0} step={1} prefix="₹"
                  placeholder={amountDue ? String(Math.round(amountDue)) : "Whole rupees"}
                  error={errors.promisedAmount?.message}
                  {...register("promisedAmount")}
                />
              </FormField>
            </div>
          )}

          <FormField label="Note" htmlFor="fu-note">
            <Textarea id="fu-note" rows={3} placeholder="e.g. Spoke to accounts — cheque on Friday" {...register("note")} />
          </FormField>
          {errors.note?.message && <p className="-mt-3 text-xs text-rose">{errors.note.message}</p>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {links.length > 0 && (
              <FormField label="About (optional)" htmlFor="fu-link">
                <select id="fu-link" className={SELECT_CLS} {...register("link")}>
                  <option value="">The customer in general</option>
                  {links.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
              </FormField>
            )}
            {canReassign ? (
              <FormField label="Follow-up with" htmlFor="fu-assigned">
                <select id="fu-assigned" className={SELECT_CLS} {...register("assignedTo")}>
                  {!assigneeDefault && <option value="">Nobody yet</option>}
                  {team.map((u) => <option key={u.id} value={u.id}>{u.label}{u.id === ownerId ? " (customer owner)" : ""}</option>)}
                </select>
              </FormField>
            ) : (
              <div className="text-sm">
                <p className="text-ink-3 text-xs uppercase tracking-wider font-semibold mb-1">Follow-up with</p>
                <p className="text-ink">{nameOf(assigneeDefault)}</p>
                <p className="text-xs text-ink-3 mt-0.5">Only an owner, manager or accountant can give it to someone else.</p>
              </div>
            )}
          </div>

          {serverError && (
            <div role="alert" className="flex flex-wrap items-start gap-2 rounded-md border border-rose/40 bg-rose/5 px-3 py-2 text-sm">
              <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-rose" />
              <span className="flex-1 min-w-0 text-ink">
                <b>Not saved.</b> {errorText(serverError.message)}
              </span>
              {serverError.status === 403 && canReassign === false && (
                <Button type="button" size="sm" variant="ghost" onClick={() => { setValue("assignedTo", assigneeDefault ?? ""); setServerError(null); }}>
                  Keep it with {nameOf(assigneeDefault)}
                </Button>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" icon="check" loading={add.isPending}>Save follow-up</Button>
          </DialogFooter>
        </form>

        <section className="mt-5 border-t border-hairline pt-4" aria-labelledby="fu-history-h">
          <h3 id="fu-history-h" className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">History</h3>
          <FollowupHistory
            entries={entries}
            names={names}
            isLoading={history.isLoading}
            isError={history.isError}
            onRetry={() => { void history.refetch(); }}
            limit={5}
          />
        </section>
      </DialogContent>
    </Dialog>
  );
}
