/**
 * POST /api/collections/followups — log one payment follow-up (R-1517).
 *
 * Why a route and not a browser insert: R-1515's RLS lets any staff role who can see the
 * customer write a follow-up, and does NOT stop a sales person from putting someone else in
 * assigned_to. Pardeep's rule (R-1514 / R-1517 mustDo): only owner / manager / accountant may
 * hand a follow-up to another person. This route is where that is enforced on the server
 * (resolveAssignee, lib/collections/followup-rules.ts); the form also hides the picker.
 *
 *   • Gate: the roles that can open /collections (nav.ts), like every other R-1470 route.
 *   • tenant_id comes from the caller's users row (withRoute), never from the body; created_by
 *     is not sent at all — the DB default auth.uid() fills it and RLS insists it is the caller.
 *     The body schema is strict, so a body carrying either is refused (400).
 *   • The insert runs on the caller's session, so RLS still decides which customers they may
 *     touch, and the same-tenant trigger still checks the invoice / quote / subscription / person.
 *
 * R-1518: the body moved, unchanged, to lib/collections/followup-log.server.ts, so the reminder
 * email route logs its follow-up through the very same checks. "Open WhatsApp" in the Remind
 * dialog logs through this route.
 */
import { withRoute } from "@/lib/api/with-route";
import { followupRequestSchema } from "@/lib/collections/followup-rules";
import { logFollowup } from "@/lib/collections/followup-log.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withRoute(
  {
    route: "api/collections/followups",
    input: followupRequestSchema,
    pages: ["/collections"],
    roleHint: "Your role cannot log payment follow-ups. Ask your manager to add it, or to give you access to Payment Follow-up.",
  },
  async ({ supabase, input, user, tenantId, role }) =>
    logFollowup(supabase, { input, userId: user.id, tenantId, role }),
);
