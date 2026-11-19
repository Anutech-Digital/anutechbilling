/**
 * AddTaskDialog — reusable "Add follow-up" form.
 *
 * Triggered from anywhere a task can be created — lead drawer,
 * customer detail, subscription card, /tasks page header.
 * Caller passes which entity the task should link to via the
 * `linkTo` prop; only ONE of the four IDs should be set.
 */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { TaskChatLink } from "@/components/features/tasks/task-notes";
import { useCreateTask, useUpdateTask } from "@/lib/queries/tasks";
import { useTeamMembers, memberLabel } from "@/lib/queries/team";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { toast } from "sonner";
import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES, TASK_PRIORITY_META, priorityForCreate, priorityOf, type TaskPriority } from "./task-priority";
import { createClient } from "@/lib/supabase/client";
import { normalizeTaskLink, sameCollaborators } from "@/lib/tasks/collaborators";
import { useSetTaskCollaborators, useTaskCollaborators } from "@/lib/queries/task-collaborators";
import { TaskCollaboratorsField } from "./task-collaborators-field";
import { ASSIGN_ME, NOT_TOLD_MESSAGE, assigneeToTell, meIdForSave, meNotKnownYet, ownerAfterSave, ownerPatch, tellAssignee } from "./assign";
import {
  TaskRelatedPicker, relatedToLinkColumns, type RelatedValue,
} from "@/components/features/tasks/task-related-picker";
import type { TaskKind, Task } from "@/lib/supabase/database.types";


const KINDS: { value: TaskKind; label: string; icon: string }[] = [
  { value: "call",     label: "Call",        icon: "📞" },
  { value: "email",    label: "Email",       icon: "✉️" },
  { value: "meeting",  label: "Meeting",     icon: "📅" },
  { value: "followup", label: "Follow-up",   icon: "🔁" },
  { value: "custom",   label: "Custom task", icon: "📋" },
];

// Pre-baked "due in X" quick-pick options. User can still pick custom.
const QUICK_DUE: { label: string; addMinutes: number }[] = [
  { label: "In 1 hour",    addMinutes: 60 },
  { label: "Today 5 PM",   addMinutes: -1 }, // sentinel — computed below
  { label: "Tomorrow 10 AM", addMinutes: -2 },
  { label: "In 3 days",    addMinutes: 60 * 24 * 3 },
  { label: "Next Monday 10 AM", addMinutes: -3 },
];

function computeQuickDue(addMinutes: number): Date {
  const now = new Date();
  if (addMinutes >= 0) return new Date(now.getTime() + addMinutes * 60_000);
  // Sentinels
  if (addMinutes === -1) {
    // Today 5pm IST → use a date with hours=17 in IST
    const t = new Date(now);
    t.setHours(17, 0, 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1); // already past, push to tomorrow
    return t;
  }
  if (addMinutes === -2) {
    // Tomorrow 10am
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    t.setHours(10, 0, 0, 0);
    return t;
  }
  if (addMinutes === -3) {
    // Next Monday 10am
    const t = new Date(now);
    const daysUntilMon = (8 - t.getDay()) % 7 || 7;
    t.setDate(t.getDate() + daysUntilMon);
    t.setHours(10, 0, 0, 0);
    return t;
  }
  return now;
}

function toLocalInputValue(d: Date): string {
  // Format Date → "YYYY-MM-DDTHH:mm" (browser-local) for <input type="datetime-local">
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const schema = z.object({
  title:  z.string().min(2, "What's the task?").max(120),
  kind:   z.enum(["call", "email", "meeting", "followup", "custom"]),
  due_at: z.string().min(1, "When is it due?"),
  notes:  z.string().max(500).optional(),
  assignee: z.string().optional(),
  priority: z.enum(TASK_PRIORITIES),
  /* R-2933: a web link for the task (Drive file, doc, page). Blank = none. */
  link: z.string().optional().refine((v) => normalizeTaskLink(v).ok, "Enter a web link like https://drive.google.com/… (or leave it empty)."),
});
type FormData = z.infer<typeof schema>;

export interface AddTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Friendly label shown in the header — e.g. customer name, lead company. */
  linkLabel?: string;
  /** Exactly one of these should be set; otherwise the task is unlinked (rare). */
  linkTo:
    | { lead_id: string }
    | { quote_id: string }
    | { customer_id: string }
    | { subscription_id: string }
    | null;
  /** When set, the dialog edits this task instead of creating a new one. */
  task?: Pick<
    Task,
    "id" | "title" | "kind" | "due_at" | "notes" | "owner_id" | "priority"
    | "lead_id" | "quote_id" | "customer_id" | "subscription_id"
  > & { link_url?: string | null } | null;
}

/** Derive the picker value from a task's link columns (only one is ever set). */
function relatedFromTask(t: AddTaskDialogProps["task"]): RelatedValue | null {
  if (!t) return null;
  if (t.lead_id)         return { kind: "lead",         id: t.lead_id };
  if (t.quote_id)        return { kind: "deal",         id: t.quote_id };
  if (t.customer_id)     return { kind: "customer",     id: t.customer_id };
  if (t.subscription_id) return { kind: "subscription", id: t.subscription_id };
  return null;
}

/** Derive the picker value from the caller's `linkTo` prop (create-from-entity). */
function relatedFromLinkTo(linkTo: AddTaskDialogProps["linkTo"]): RelatedValue | null {
  if (!linkTo) return null;
  if ("lead_id"         in linkTo) return { kind: "lead",         id: linkTo.lead_id };
  if ("quote_id"        in linkTo) return { kind: "deal",         id: linkTo.quote_id };
  if ("customer_id"     in linkTo) return { kind: "customer",     id: linkTo.customer_id };
  if ("subscription_id" in linkTo) return { kind: "subscription", id: linkTo.subscription_id };
  return null;
}

export function AddTaskDialog({ open, onOpenChange, linkLabel, linkTo, task }: AddTaskDialogProps) {
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const { data: members = [] } = useTeamMembers();
  const { data: me } = useCurrentUser();
  const isEdit = Boolean(task);

  // Default due: in 1 hour. Computed once per mount — defaultValues is read
  // by useForm on first call, so recomputing on `open` toggle has no effect.
  const defaultDue = React.useMemo(() => toLocalInputValue(computeQuickDue(60)), []);

  const {
    register, handleSubmit, reset, setValue, watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { title: "", kind: "followup", due_at: defaultDue, notes: "", assignee: ASSIGN_ME, priority: DEFAULT_TASK_PRIORITY, link: "" },
  });

  // Which customer / lead / deal this task is attached to (editable in the form).
  const [related, setRelated] = React.useState<RelatedValue | null>(null);

  /* R-2933: up to 3 teammates working with the owner. `savedWith` = what the task has now
     (null until that read has answered — then the field is not shown and nothing is changed). */
  const collab = useTaskCollaborators(me?.tenantId, { enabled: open });
  const setCollaborators = useSetTaskCollaborators();
  const taskId = task?.id ?? null;
  const savedWith = React.useMemo<readonly string[] | null>(
    () => (collab.data ? (taskId ? collab.data.get(taskId) ?? [] : []) : null),
    [collab.data, taskId],
  );
  const [workingWith, setWorkingWith] = React.useState<string[]>([]);
  const withTouched = React.useRef(false);
  React.useEffect(() => {
    if (!open) { withTouched.current = false; return; }
    if (!withTouched.current) setWorkingWith(savedWith ? [...savedWith] : []);
  }, [open, savedWith]);

  React.useEffect(() => {
    if (!open) return;
    if (task) {
      // Edit mode — pre-fill from the task (ISO due → browser-local input value).
      reset({
        title:  task.title,
        kind:   task.kind,
        due_at: toLocalInputValue(new Date(task.due_at)),
        notes:  task.notes ?? "",
        assignee: task.owner_id ?? ASSIGN_ME,
        priority: priorityOf(task),
        link: task.link_url ?? "",
      });
      setRelated(relatedFromTask(task));
    } else {
      reset({ title: "", kind: "followup", due_at: defaultDue, notes: "", assignee: ASSIGN_ME, priority: DEFAULT_TASK_PRIORITY, link: "" });
      setRelated(relatedFromLinkTo(linkTo));
    }
  }, [open, task, linkTo, defaultDue, reset]);

  const watchedKind = watch("kind");
  const watchedAssignee = watch("assignee");
  const watchedPriority = watch("priority");
  /* R-471: a past due time used to save silently and land straight in Overdue. Say so
     (it is allowed — logging a missed call is real), and offer "in 1 hour". */
  const watchedDue = watch("due_at");
  const dueIsPast = !!watchedDue && Date.parse(watchedDue) < Date.now() && (!task || watchedDue !== toLocalInputValue(new Date(task.due_at)));

  const onSubmit = async (data: FormData) => {
    // Local datetime → ISO UTC
    const dueISO = new Date(data.due_at).toISOString();
    // R-2925: "Me" on a new task leaves owner_id to the default (creator); on an edit of
    // someone else's task it takes the task. A member id assigns / reassigns to that teammate.
    // The profile may still be loading right after the page opens — the session knows who is saving.
    const meId = await meIdForSave(me?.userId, async () => (await createClient().auth.getUser()).data.user?.id);
    const who = { assignee: data.assignee, isEdit: Boolean(task), meId, currentOwnerId: task?.owner_id };
    if (meNotKnownYet(who)) {
      toast.warning("Still loading your profile — please press Save again in a moment.");
      return;
    }
    const owner = ownerPatch(who);
    // The new owner is told (bell + email) — never me, never the person who already had it.
    const tell = (taskId: string, previousOwnerId: string | null | undefined) => {
      if (!assigneeToTell({ newOwnerId: owner.owner_id, previousOwnerId, meId })) return;
      void tellAssignee(taskId).then((ok) => { if (!ok) toast.warning(NOT_TOLD_MESSAGE); });
    };

    const link = normalizeTaskLink(data.link);
    const linkUrl = link.ok ? link.url : null;
    // R-2933: the people working with the owner are saved after the task (the owner is never one of them).
    const ownerAfter = ownerAfterSave(who);
    const saveWith = async (id: string) => {
      if (savedWith === null) return; // the list never loaded — leave it as it is
      const next = workingWith.filter((u) => u !== ownerAfter);
      if (sameCollaborators(savedWith, next)) return;
      const r = await setCollaborators.mutateAsync({ taskId: id, userIds: next }).catch(() => ({ ok: false, message: undefined }));
      if (!r.ok) toast.warning(r.message ?? "Task saved, but the people working with it could not be saved — open the task and try again.");
    };

    if (task) {
      // Edit — editable fields + the entity link (which the user can now change).
      await updateTask.mutateAsync({
        id: task.id,
        patch: {
          title:  data.title.trim(),
          kind:   data.kind,
          due_at: dueISO,
          notes:  data.notes?.trim() || null,
          priority: data.priority,
          ...(linkUrl !== (task.link_url ?? null) ? { link_url: linkUrl } : {}),
          ...owner,
          ...relatedToLinkColumns(related),
        },
      });
      tell(task.id, task.owner_id);
      await saveWith(task.id);
      onOpenChange(false);
      return;
    }

    const created = await createTask.mutateAsync({
      title:  data.title.trim(),
      kind:   data.kind,
      due_at: dueISO,
      notes:  data.notes?.trim() || null,
      ...priorityForCreate(data.priority),
      ...(linkUrl ? { link_url: linkUrl } : {}),
      ...owner,
      ...relatedToLinkColumns(related),
    });
    if (created?.id) { tell(created.id, null); await saveWith(created.id); }
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[440px] md:max-w-[480px] p-0 flex flex-col overflow-x-hidden"
      >
        <SheetHeader>
          <SheetTitle>{isEdit ? "Edit task" : "Add follow-up task"}</SheetTitle>
          <SheetDescription>
            {isEdit
              ? <>Update this reminder{linkLabel ? <> for <b>{linkLabel}</b></> : null}.</>
              : linkLabel
              ? <>Schedule a reminder linked to <b>{linkLabel}</b>. You&apos;ll see it on the dashboard, the bell, and the Tasks page when due.</>
              : <>Schedule a reminder. You&apos;ll see it on the dashboard, the bell, and the Tasks page when due.</>}
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col flex-1 min-h-0 min-w-0 w-full"
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          <FormField label="What's the task?" required htmlFor="title">
            <Input
              id="title"
              placeholder={
                watchedKind === "call"    ? "Call Rohit about renewal" :
                watchedKind === "email"   ? "Send Sharma the migration plan" :
                watchedKind === "meeting" ? "Demo with TechBrand 11 AM" :
                "Follow up on quote"
              }
              error={errors.title?.message}
              {...register("title")}
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Type" htmlFor="kind">
              <Select
                value={watchedKind}
                onValueChange={(v) => setValue("kind", v as TaskKind, { shouldValidate: true })}
              >
                <SelectTrigger id="kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      <span className="mr-1.5">{k.icon}</span> {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("kind")} />
            </FormField>

            <FormField label="Due" required htmlFor="due_at">
              <Input
                id="due_at"
                type="datetime-local"
                error={errors.due_at?.message}
                {...register("due_at")}
              />
            </FormField>
          </div>

          {dueIsPast && (
            <p role="status" className="text-xs text-amber-ink -mt-2">
              This time has already passed — the task will show as Overdue.{" "}
              <button
                type="button"
                className="underline font-medium"
                onClick={() => setValue("due_at", toLocalInputValue(computeQuickDue(60)), { shouldValidate: true })}
              >
                Use in 1 hour
              </button>
            </p>
          )}

          {/* Quick-pick due chips */}
          <div className="flex flex-wrap gap-1.5">
            {QUICK_DUE.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() =>
                  setValue("due_at", toLocalInputValue(computeQuickDue(q.addMinutes)), {
                    shouldValidate: true,
                  })
                }
                className="text-2xs px-2 py-1 rounded-full border border-hairline text-ink-2 hover:bg-paper-2 transition-colors"
              >
                {q.label}
              </button>
            ))}
          </div>

          {/* R-2926: Low / Medium / High — High sorts first inside its group of the Tasks list. */}
          <FormField label="Priority" htmlFor="priority">
            <Select
              value={watchedPriority}
              onValueChange={(v) => setValue("priority", v as TaskPriority, { shouldValidate: true })}
            >
              <SelectTrigger id="priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...TASK_PRIORITIES].reverse().map((p) => (
                  <SelectItem key={p} value={p}>{TASK_PRIORITY_META[p].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="hidden" {...register("priority")} />
          </FormField>

          <FormField label="Assign to" htmlFor="assignee">
            <Select
              value={watchedAssignee || ASSIGN_ME}
              onValueChange={(v) => setValue("assignee", v, { shouldValidate: true })}
            >
              <SelectTrigger id="assignee">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ASSIGN_ME}>Me (myself)</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {memberLabel(m)}{m.role ? ` · ${m.role}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="hidden" {...register("assignee")} />
            <p className="text-2xs text-ink-3 mt-1">
              Only teammates with a login appear here. Invite more at{" "}
              <a href="/team" className="text-amber-ink underline">Team</a>.
            </p>
          </FormField>

          {/* R-2933: teammates working with the owner (max 3). Hidden until the current list is known. */}
          {savedWith !== null && (
            <FormField label="Working with (optional)">
              <TaskCollaboratorsField
                members={members}
                ownerId={ownerAfterSave({ assignee: watchedAssignee, isEdit, meId: me?.userId, currentOwnerId: task?.owner_id })}
                value={workingWith}
                onChange={(next) => { withTouched.current = true; setWorkingWith(next); }}
              />
            </FormField>
          )}

          <FormField label="Link (optional)" htmlFor="link">
            <Input
              id="link"
              type="text"
              inputMode="url"
              placeholder="https://drive.google.com/…"
              error={errors.link?.message}
              {...register("link")}
            />
            <p className="text-2xs text-ink-3 mt-1">A Drive file, document or page for this task — it opens from the task&apos;s row.</p>
          </FormField>

          <FormField label="Related to (optional)" htmlFor="related">
            <TaskRelatedPicker value={related} onChange={setRelated} />
            <p className="text-2xs text-ink-3 mt-1">
              Link this task to a customer, lead or deal — you&apos;ll get a one-tap
              &ldquo;Open&rdquo; from the task, and it shows on that record.
            </p>
          </FormField>

          <FormField label="Notes (optional)" htmlFor="notes">
            <Textarea
              id="notes"
              placeholder="Any context for future-you. What to say, what to bring up, what was discussed."
              rows={3}
              {...register("notes")}
            />
            {/* R-2327: a task made from Team chat opens that post from here too. */}
            <TaskChatLink notes={task?.notes} className="mt-1" />
          </FormField>

          </div>  {/* close scrollable form body */}

          <SheetFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon="check"
              loading={isSubmitting || createTask.isPending || updateTask.isPending}
            >
              {isEdit ? "Save changes" : "Schedule"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
