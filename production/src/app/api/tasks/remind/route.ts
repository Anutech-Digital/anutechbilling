/**
 * POST /api/tasks/remind — { taskId }
 * R-2928: the "Remind" button on a teammate's task — bell notice + email to the task's owner,
 * and the task remembers when it was last reminded. Any role that can open Tasks; once per task
 * per hour (409 with a plain message otherwise).
 */
import { z } from "zod";
import { RouteError, withRoute } from "@/lib/api/with-route";
import { sendTaskReminder } from "@/lib/tasks/remind-notice.server";
import { NOTICE_NOT_SENT, NOTICE_NOT_SENT_HOUR_KEPT, noReminderMessage } from "@/lib/tasks/remind-notice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({ taskId: z.string().uuid() });

export const POST = withRoute(
  { route: "api/tasks/remind", input: schema, pages: ["/tasks"] },
  async ({ input, supabase, tenantId, user }) => {
    const r = await sendTaskReminder(supabase, { taskId: input.taskId, tenantId, actorId: user.id });
    if (!r.reminded) {
      const reason = r.reason ?? "task not found";
      // R-2941: our side could not send anything (bell and email both failed) → 503.
      const status = reason === "task not found" ? 404 : reason === NOTICE_NOT_SENT || reason === NOTICE_NOT_SENT_HOUR_KEPT ? 503 : 409;
      throw new RouteError(status, noReminderMessage(reason, r.lastFollowupAt));
    }
    return { reminded: true, emailed: r.emailed, lastFollowupAt: r.lastFollowupAt ?? null };
  },
);
