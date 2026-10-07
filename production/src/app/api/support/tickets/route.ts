/**
 * GET & PATCH /api/support/tickets — Cross-Tenant Support Desk & Bug Tracker.
 *
 * Logically classifies:
 * 1. Tenant / Customer Feedback: All tickets & bug reports submitted by external Resellers/Tenants
 *    (e.g., ranjeetraj@exceltechnologies.in, support@veraciouscreate.com, it-head@apexglobal.com).
 * 2. Internal Team Reports: Bug reports submitted by internal Anutech Digital team employees.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";
import type { TablesUpdate } from "@/lib/supabase/database.types";

const ANUTECH_PRIMARY_TENANT_ID = "fbb976f1-9090-4f10-9726-0901bd144e42";

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
    const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).single();
    tenantId = me?.tenant_id ?? null;
  }

  // 2. Fetch all relevant tickets for evaluation & classification
  let q = client.from("support_tickets").select("*").order("created_at", { ascending: false });

  if (!isAdmin && tenantId) {
    q = q.eq("tenant_id", tenantId);
  }

  const { data: allTickets, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 3. Logically filter and compute counts based on Tenant vs Internal Employee origin
  const counts: Record<string, number> = { all: 0, open: 0, in_progress: 0, awaiting_customer: 0, resolved: 0, closed: 0 };
  const scopeCounts = { tenant_feedback: 0, team_testing: 0 };

  const filteredTickets = (allTickets ?? []).filter((t) => {
    // A ticket is from an Internal Team Employee if it comes from the primary Anutech Digital tenant AND has a team bug tag AND raised by internal employee
    const isInternalTag = t.subject && (t.subject.includes("[BUG]") || t.subject.includes("[FEATURE]") || t.subject.includes("[UI_IMPROVEMENT]"));
    const isInternalTenant = t.tenant_id === ANUTECH_PRIMARY_TENANT_ID;
    
    // Check if the ticket explicitly belongs to an external tenant (by email, body text, or reporter name)
    const isExternalTenant = Boolean(
      (t.raised_by_email && !t.raised_by_email.endsWith("@anutechdigital.com") && !t.raised_by_email.endsWith("@anutech.in")) ||
      (t.body && /exceltechnologies|ranjeetraj|veraciouscreate|apexglobal/i.test(t.body)) ||
      (t.customer_name && /ranjeet|veracious|apex/i.test(t.customer_name))
    );
    
    // External Tenants (e.g. ranjeetraj@exceltechnologies.in) ALWAYS belong in tenant_feedback even if they report a bug
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

  return NextResponse.json({ tickets: filteredTickets, counts, scopeCounts });
}

export async function PATCH(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const isAdmin = isPlatformAdmin(user.email);
  const client = isAdmin ? createAdminClientFor(user.id) : supabase;

  const body = await request.json().catch(() => ({}));
  const { id, status, resolution_note } = body;

  if (!id) return NextResponse.json({ error: "Missing ticket ID" }, { status: 400 });

  const updates: TablesUpdate<"support_tickets"> = {};
  if (status) updates.status = status;
  if (resolution_note !== undefined) updates.resolution_note = resolution_note;
  if (status === "resolved" || status === "closed") {
    updates.resolved_at = new Date().toISOString();
  }

  const { data: updated, error } = await client
    .from("support_tickets")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, ticket: updated });
}
