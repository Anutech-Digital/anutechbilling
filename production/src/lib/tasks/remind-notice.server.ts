/**
 * R-2928 — remind a teammate about their task: one bell notification (kind task.reminder), one
 * email, and the task remembers when (tasks.last_followup_at) and how often (followup_count).
 * Server-only. Called by POST /api/tasks/remind from the "Remind" button on a task row.
 *
 * Trust: the task is read through the CALLER'S session and pinned to their tenant, so a caller
 * can only remind about a task of their own company that they can see. Everything said in the
 * notice comes from that task row and the users table — nothing from the request body except
 * the task id. Once per task per hour (whyNoReminder); the stamp is taken BEFORE anything is
 * sent, on the value that was read, so two presses at the same moment send one reminder.
 */
import "server-only";
import { createAdminClient, type createClient } from "@/lib/supabase/server";
import { sendInternalEmail } from "@/lib/messaging";
import { notifyPeople } from "@/lib/notifications/notify.server";
import { appUrl } from "@/lib/app-url";
import { mayOpenPage } from "@/lib/api/with-route";
import { relatedOf, type AssignedTask } from "./assign-notice";
import { remindEmail, remindNotification, whyNoReminder, type NoReminderReason } from "./remind-notice";

export interface RemindResult {
  reminded: boolean;
  emailed: boolean;
  /** Why nothing was sent — for the message the person reads, the log and tests. */
  reason?: NoReminderReason | "task not found";
  /** When this task was last reminded (now, after a reminder that went). */
  lastFollowupAt?: string | null;
}

type UserClient = ReturnType<typeof createClient>;

const TASK_COLUMNS = "id, title, notes, due_at, status, owner_id, last_followup_at, followup_count, lead_id, quote_id, customer_id, subscription_id, leads(company, contact_name), customers(name), quotes(customer_name)";

type TaskRead = AssignedTask & {
  status: string;
  last_followup_at: string | null;
  followup_count: number | null;
  leads?: { company: string | null; contact_name: string | null } | null;
  customers?: { name: string | null } | null;
  quotes?: { customer_name: string | null } | null;
};

export async function sendTaskReminder(
  supabase: UserClient,
  input: { taskId: string; tenantId: string; actorId: string; now?: Date },
): Promise<RemindResult> {
  const { taskId, tenantId, actorId } = input;
  const now = input.now ?? new Date();

  const { data: taskRow, error: taskErr } = await supabase
    .from("tasks").select(TASK_COLUMNS).eq("id", taskId).eq("tenant_id", tenantId).maybeSingle();
  if (taskErr) throw new Error(`task read failed: ${taskErr.message}`);
  const task = taskRow as unknown as TaskRead | null;
  if (!task) return { reminded: false, emailed: false, reason: "task not found" };

  const admin = createAdminClient();
  const people = [actorId, ...(task.owner_id ? [task.owner_id] : [])];
  const { data: users, error: usersErr } = await admin
    .from("users").select("id, full_name, email, is_active, role").eq("tenant_id", tenantId).in("id", people);
  if (usersErr) throw new Error(`users read failed: ${usersErr.message}`);
  type U = { id: string; full_name: string | null; email: string | null; is_active: boolean | null; role: string | null };
  const byId = new Map(((users ?? []) as U[]).map((u) => [u.id, u]));
  const assignee = task.owner_id ? byId.get(task.owner_id) ?? null : null;
  const actor = byId.get(actorId) ?? null;

  const reason = whyNoReminder({ task, actorId, assignee, now: now.getTime() });
  if (reason || !assignee) {
    return { reminded: false, emailed: false, reason: reason ?? "no owner", ...(reason === "reminded recently" ? { lastFollowupAt: task.last_followup_at } : {}) };
  }

  // Take the stamp first, only if nobody stamped since our read (compare-and-set on the value read).
  const stampedAt = now.toISOString();
  const stamp = admin.from("tasks")
    .update({ last_followup_at: stampedAt, followup_count: (task.followup_count ?? 0) + 1 })
    .eq("id", task.id).eq("tenant_id", tenantId);
  const { data: stamped, error: stampErr } = await (
    task.last_followup_at ? stamp.eq("last_followup_at", task.last_followup_at) : stamp.is("last_followup_at", null)
  ).select("id");
  if (stampErr) throw new Error(`reminder stamp failed: ${stampErr.message}`);
  if (!stamped?.length) return { reminded: false, emailed: false, reason: "reminded recently" };

  const nameOf = (u: U | null) => u?.full_name?.trim() || u?.email?.split("@")[0] || "A teammate";
  const actorName = nameOf(actor);
  // A role that cannot open Tasks (accountant, billing…) is not sent to a page that refuses them.
  const canOpenTasks = mayOpenPage(assignee.role, ["/tasks"]);

  const n = remindNotification({ task, actorName, canOpenTasks });
  await notifyPeople({ tenantId, kind: n.kind, title: n.title, body: n.body, href: n.href, entityId: n.entityId }, { userIds: [assignee.id] });

  // The email is best effort: the bell notice is written and the task is stamped.
  let emailed = false;
  if (assignee.email) {
    try {
      const { data: tenant } = await admin.from("tenants").select("name").eq("id", tenantId).maybeSingle();
      const mail = remindEmail({
        task, assigneeName: nameOf(assignee), actorName,
        companyName: (tenant as { name?: string | null } | null)?.name?.trim() || "your company",
        baseUrl: appUrl(), canOpenTasks,
        related: relatedOf(task, {
          lead: task.leads?.company?.trim() || task.leads?.contact_name,
          quote: task.quotes?.customer_name,
          customer: task.customers?.name,
        }),
      });
      const sent = await sendInternalEmail({
        to: assignee.email, subject: mail.subject, text: mail.text, html: mail.html,
        route: { tenantId }, kind: "task_reminder",
      });
      emailed = sent.status === "sent";
      if (sent.status === "failed") console.error("[tasks/remind] email failed:", sent.errorMessage);
    } catch (e) {
      console.error("[tasks/remind] email crashed:", (e as Error).message);
    }
  }
  return { reminded: true, emailed, lastFollowupAt: stampedAt };
}
