/**
 * R-2925 — tell a task's new owner: one bell notification (kind task.assigned) and one email
 * with the task's details. Server-only. Called by POST /api/tasks/assigned right after the
 * Add / Edit task dialog saved a task for someone else.
 *
 * Trust: the task is read through the CALLER'S session and pinned to their tenant, so a caller
 * can only ever announce a task of their own company. Everything said in the notice comes from
 * that task row and the users table — nothing from the request body except the task id.
 * Only the person who handed the task over (tasks.delegated_by, stamped by the save itself) can
 * have the owner told, and once per hand-over (whyNoNotice).
 */
import "server-only";
import { createAdminClient, type createClient } from "@/lib/supabase/server";
import { sendInternalEmail } from "@/lib/messaging";
import { notifyPeople } from "@/lib/notifications/notify.server";
import { appUrl } from "@/lib/app-url";
import { mayOpenPage } from "@/lib/api/with-route";
import { assignEmail, assignNotification, relatedOf, whyNoNotice, type AssignedTask } from "./assign-notice";

export interface AssignNoticeResult {
  notified: boolean;
  emailed: boolean;
  /** Why nothing was sent (own task, already told, …) — for the log and tests. */
  reason?: string;
}

type UserClient = ReturnType<typeof createClient>;

const TASK_COLUMNS = "id, title, notes, due_at, owner_id, delegated_by, delegated_at, lead_id, quote_id, customer_id, subscription_id, leads(company, contact_name), customers(name), quotes(customer_name)";

type TaskRead = AssignedTask & {
  leads?: { company: string | null; contact_name: string | null } | null;
  customers?: { name: string | null } | null;
  quotes?: { customer_name: string | null } | null;
};

export async function sendTaskAssignedNotice(
  supabase: UserClient,
  input: { taskId: string; tenantId: string; actorId: string },
): Promise<AssignNoticeResult> {
  const { taskId, tenantId, actorId } = input;

  const { data: taskRow, error: taskErr } = await supabase
    .from("tasks").select(TASK_COLUMNS).eq("id", taskId).eq("tenant_id", tenantId).maybeSingle();
  if (taskErr) throw new Error(`task read failed: ${taskErr.message}`);
  const task = taskRow as unknown as TaskRead | null;
  if (!task) return { notified: false, emailed: false, reason: "task not found" };

  const admin = createAdminClient();
  const people = [actorId, ...(task.owner_id ? [task.owner_id] : [])];
  const { data: users, error: usersErr } = await admin
    .from("users").select("id, full_name, email, is_active, role").eq("tenant_id", tenantId).in("id", people);
  if (usersErr) throw new Error(`users read failed: ${usersErr.message}`);
  type U = { id: string; full_name: string | null; email: string | null; is_active: boolean | null; role: string | null };
  const byId = new Map(((users ?? []) as U[]).map((u) => [u.id, u]));
  const assignee = task.owner_id ? byId.get(task.owner_id) ?? null : null;
  const actor = byId.get(actorId) ?? null;

  let lastToldAt: string | null = null;
  if (assignee) {
    const { data: prior, error: priorErr } = await admin
      .from("notifications").select("created_at")
      .eq("tenant_id", tenantId).eq("user_id", assignee.id).eq("kind", "task.assigned")
      .eq("entity_id", task.id).order("created_at", { ascending: false }).limit(1);
    if (priorErr) throw new Error(`notification read failed: ${priorErr.message}`);
    lastToldAt = ((prior ?? []) as { created_at: string }[])[0]?.created_at ?? null;
  }

  const reason = whyNoNotice({ task, actorId, assignee, lastToldAt });
  if (reason || !assignee) return { notified: false, emailed: false, reason: reason ?? "no owner" };

  const nameOf = (u: U | null) => u?.full_name?.trim() || u?.email?.split("@")[0] || "A teammate";
  const actorName = nameOf(actor);

  // A role that cannot open Tasks (accountant, billing…) is not sent to a page that refuses them.
  const canOpenTasks = mayOpenPage(assignee.role, ["/tasks"]);

  const n = assignNotification({ task, actorName, canOpenTasks });
  await notifyPeople({ tenantId, kind: n.kind, title: n.title, body: n.body, href: n.href, entityId: n.entityId }, { userIds: [assignee.id] });

  // The email is best effort: the bell notice is written, the task is saved.
  let emailed = false;
  if (assignee.email) {
    try {
      const { data: tenant } = await admin.from("tenants").select("name").eq("id", tenantId).maybeSingle();
      const mail = assignEmail({
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
        route: { tenantId }, kind: "task_assigned",
      });
      emailed = sent.status === "sent";
      if (sent.status === "failed") console.error("[tasks/assigned] email failed:", sent.errorMessage);
    } catch (e) {
      console.error("[tasks/assigned] email crashed:", (e as Error).message);
    }
  }
  return { notified: true, emailed };
}
