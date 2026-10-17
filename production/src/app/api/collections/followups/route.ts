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
 */
import { withRoute, RouteError, dbFail } from "@/lib/api/with-route";
import {
  buildFollowupInsert, defaultAssignee, followupRequestSchema, resolveAssignee,
} from "@/lib/collections/followup-rules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withRoute(
  {
    route: "api/collections/followups",
    input: followupRequestSchema,
    pages: ["/collections"],
    roleHint: "Your role cannot log payment follow-ups. Ask your manager to add it, or to give you access to Payment Follow-up.",
  },
  async ({ supabase, input, user, tenantId, role }) => {
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .select("id, account_manager_id")
      .eq("id", input.customerId)
      .maybeSingle();
    dbFail(custErr, "Could not read this customer — reload the page and try again.");
    if (!customer) {
      throw new RouteError(404, "This customer is not in your list any more — reload Payment Follow-up and pick them again.");
    }

    const { data: latest, error: latestErr } = await supabase
      .from("payment_followups")
      .select("assigned_to")
      .eq("customer_id", input.customerId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    dbFail(latestErr, "Could not read this customer's follow-ups — reload the page and try again.");

    const decision = resolveAssignee({
      role,
      requested: input.assignedTo,
      defaultId: defaultAssignee({ latestAssignedTo: latest?.assigned_to, ownerId: customer.account_manager_id, meId: user.id }),
    });
    if (!decision.ok) throw new RouteError(decision.status, decision.error);

    const { data: row, error } = await supabase
      .from("payment_followups")
      .insert(buildFollowupInsert(input, tenantId, decision.assignedTo))
      .select("id, assigned_to")
      .single();
    if (error?.code === "23514") {
      throw new RouteError(400, "The linked invoice, subscription or person is not in this company, or a promise has no date — pick them again and save.", `${error.code} ${error.message}`);
    }
    if (error?.code === "42501") {
      throw new RouteError(403, "You cannot add a follow-up for this customer — ask the customer's owner or your manager to add it.", `${error.code} ${error.message}`);
    }
    dbFail(error, "The follow-up was not saved — check your connection and press Save again.");

    return { id: row!.id, assignedTo: row!.assigned_to };
  },
);
