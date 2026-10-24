/**
 * GET & PATCH /api/support/tickets — Cross-Tenant Support Desk & Bug Tracker.
 *
 * Logically classifies:
 * 1. Tenant / Customer Feedback: All tickets & bug reports submitted by external Resellers/Tenants
 *    (e.g. someone@customer.example.test).
 * 2. Internal Team Reports: Bug reports submitted by internal Anutech Digital team employees.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";
import type { TablesUpdate } from "@/lib/supabase/database.types";
import { mayDo } from "@/lib/auth/action-roles";
import { safeDbMessage, logDbError } from "@/lib/errors/db-error";

const ANUTECH_PRIMARY_TENANT_ID = "fbb976f1-9090-4f10-9726-0901bd144e42";

/** R-1432: words that mark a ticket body / reporter as an outside tenant. They used to be a
 *  hard-coded regex of real customer names; now an optional comma list in env (empty = off). */
function externalMarkers(): RegExp | null {
  const words = (process.env.SUPPORT_EXTERNAL_MARKERS ?? "")
    .split(",").map((w) => w.trim()).filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return words.length ? new RegExp(words.join("|"), "i") : null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope") || "tenant_feedback";
  const statusFilter = searchParams.get("status") || "open";

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const isAdmin = isPlatformAdmin(user.email);
  const client = isAdmin ? createAdminClientFor(user.id) : supabase;

  // 1. Fetch user's tenant ID if not platform admin
  let tenantId: string | null = null;
  if (!isAdmin) {
    const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
    tenantId = me?.tenant_id ?? null;
    /* R-1487: fail closed. Without a workspace there is nothing of theirs to list — never
       fall through to an unfiltered query and leave RLS as the only wall. */
    if (!tenantId) {
      return NextResponse.json({ error: "Your account is not linked to a workspace yet." }, { status: 403 });
    }
  }

  // 2. Fetch all relevant tickets for evaluation & classification.
  //    Only a platform admin (Anutech staff) reads across workspaces; everyone else is pinned
  //    to their own tenant here AND by RLS (support_tickets_select_own_tenant).
  let q = client.from("support_tickets").select("*").order("created_at", { ascending: false });

  if (!isAdmin && tenantId) {
    q = q.eq("tenant_id", tenantId);
  }

  const { data: allTickets, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 3. Logically filter and compute counts based on Tenant vs Internal Employee origin
  const counts: Record<string, number> = { all: 0, open: 0, in_progress: 0, awaiting_customer: 0, resolved: 0, closed: 0 };
  const scopeCounts = { tenant_feedback: 0, team_testing: 0 };

  const markers = externalMarkers();
  const filteredTickets = (allTickets ?? []).filter((t) => {
    // A ticket is from an Internal Team Employee if it comes from the primary Anutech Digital tenant AND has a team bug tag AND raised by internal employee
    const isInternalTag = t.subject && (t.subject.includes("[BUG]") || t.subject.includes("[FEATURE]") || t.subject.includes("[UI_IMPROVEMENT]"));
    const isInternalTenant = t.tenant_id === ANUTECH_PRIMARY_TENANT_ID;
    
    // Check if the ticket explicitly belongs to an external tenant (by email, body text, or reporter name)
    const isExternalTenant = Boolean(
      (t.raised_by_email && !t.raised_by_email.endsWith("@anutechdigital.com") && !t.raised_by_email.endsWith("@anutech.in")) ||
      Boolean(markers && ((t.body && markers.test(t.body)) || (t.customer_name && markers.test(t.customer_name))))
    );
    
    // External tenants ALWAYS belong in tenant_feedback even if they report a bug
    const isTeamScope = isInternalTenant && isInternalTag && !isExternalTenant;

    if (isTeamScope) scopeCounts.team_testing += 1;
    else scopeCounts.tenant_feedback += 1;

    // Check if ticket matches current scope filter (all | tenant_feedback | team_testing)
    const matchesScope = scope === "all" ? true : scope === "team_testing" ? isTeamScope : !isTeamScope;
    if (!matchesScope) return false;

    // Increment status counter for current scope
    counts.all += 1;
    counts[t.status as string] = (counts[t.status as string] ?? 0) + 1;

    // Check status filter
    if (statusFilter !== "all" && t.status !== statusFilter) {
      return false;
    }

    return true;
  });

  // crossTenant (R-1487): tells the desk whether "across all workspaces" is true for this viewer.
  return NextResponse.json({ tickets: filteredTickets, counts, scopeCounts, crossTenant: isAdmin });
}

/** R-880: the only values PATCH may write. Anything else is refused, not stored. */
const TICKET_STATUSES = ["open", "in_progress", "awaiting_customer", "resolved", "closed"] as const;
type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * PATCH — change a ticket's status and/or resolution note. Nothing else is writable here.
 *
 * R-880: before this any signed-in member (sales, delivery…) could close or re-open any
 * ticket of the company. Now: owner, manager, support — or the agent the ticket is assigned
 * to (support_tickets.assigned_agent). The ticket is looked up inside the caller's tenant
 * first, so another company's ticket id reads as "not found". A platform admin (Anutech
 * staff, isPlatformAdmin) still works across tenants — that is the cross-tenant desk.
 */
export async function PATCH(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const isAdmin = isPlatformAdmin(user.email);

  const body = await request.json().catch(() => ({}));
  const { id, status, resolution_note } = (body ?? {}) as { id?: unknown; status?: unknown; resolution_note?: unknown };

  if (!id || typeof id !== "string") return NextResponse.json({ error: "Missing ticket ID" }, { status: 400 });
  if (status !== undefined && status !== null && status !== "" &&
      !(typeof status === "string" && (TICKET_STATUSES as readonly string[]).includes(status))) {
    return NextResponse.json({ error: "Unknown ticket status." }, { status: 400 });
  }
  if (resolution_note !== undefined && resolution_note !== null && typeof resolution_note !== "string") {
    return NextResponse.json({ error: "Resolution note must be text." }, { status: 400 });
  }
  if (typeof resolution_note === "string" && resolution_note.length > 5000) {
    return NextResponse.json({ error: "Resolution note is too long (max 5000 characters)." }, { status: 400 });
  }

  let tenantId: string | null = null;
  if (!isAdmin) {
    const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
    tenantId = me?.tenant_id ?? null;
    if (!tenantId) {
      return NextResponse.json({ error: "Your account is not linked to a workspace yet." }, { status: 403 });
    }
    const { data: ticket } = await supabase
      .from("support_tickets").select("id, assigned_agent").eq("id", id).eq("tenant_id", tenantId).maybeSingle();
    if (!ticket) return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
    const assignedToMe = !!ticket.assigned_agent && ticket.assigned_agent === user.id;
    if (!mayDo((me as { role?: string | null }).role, "support.update") && !assignedToMe) {
      return NextResponse.json(
        { error: "Only Owner, Manager, Support or the person this ticket is assigned to can update it. Ask one of them to do it." },
        { status: 403 },
      );
    }
  }

  const client = isAdmin ? createAdminClientFor(user.id) : supabase;

  const updates: TablesUpdate<"support_tickets"> = {};
  if (status) updates.status = status as TicketStatus;
  if (resolution_note !== undefined) updates.resolution_note = resolution_note as string | null;
  if (status === "resolved" || status === "closed") {
    updates.resolved_at = new Date().toISOString();
  }

  let q = client.from("support_tickets").update(updates).eq("id", id);
  if (tenantId) q = q.eq("tenant_id", tenantId);
  const { data: updated, error } = await q.select().single();

  if (error) {
    logDbError("support/tickets:patch", error);
    return NextResponse.json({ error: safeDbMessage(error, "Could not update the ticket. Reload and try again.") }, { status: 500 });
  }
  return NextResponse.json({ success: true, ticket: updated });
}
