/**
 * PATCH /api/inbound-emails/[id]/state — read, star, snooze, archive.
 *
 * The four things a person does to a mail, kept apart from `status`, which is what
 * the webhook did with it (see migration 20260817140000).
 *
 * ─── THIS ROUTE RESOLVES THE TENANT FROM THE SESSION, WITH NO FALLBACK ──────
 * GET /api/inbound-emails falls back to a default tenant id when there is no user,
 * for local preview. That is tolerable for a READ behind an authenticated layout.
 * It is not tolerable here: a write that guessed a tenant would let an unauthenticated
 * request archive another company's enquiries. No session, no write.
 *
 * The update is then scoped by id AND tenant_id — belt and braces, because the
 * service-role client bypasses RLS and the id alone is a valid key for any row in
 * the table.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  /** Mark opened. Only ever set, never cleared — see below. */
  read:     z.boolean().optional(),
  starred:  z.boolean().optional(),
  /** ISO instant to hide it until, or null to wake it now. */
  snoozeUntil: z.string().datetime().nullable().optional(),
  archived: z.boolean().optional(),
});

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  const { data: me } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json(
      {
        error: "Your account is not linked to a company yet.",
        nextStep: "Open Team settings and finish joining, or ask the owner to add you.",
      },
      { status: 403 },
    );
  }

  let raw: unknown;
  try { raw = await req.json(); } catch { raw = {}; }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Nothing valid to change on this email." }, { status: 400 });
  }
  const b = parsed.data;

  /* Typed to the columns rather than Record<string, …>: an index signature would let
     a typo through as a new column name and Postgres would reject it at runtime. */
  const patch: {
    starred?:       boolean;
    snoozed_until?: string | null;
    archived_at?:   string | null;
    read_at?:       string | null;
  } = {};
  if (b.starred !== undefined) patch.starred = b.starred;
  if (b.snoozeUntil !== undefined) patch.snoozed_until = b.snoozeUntil;
  if (b.archived !== undefined) patch.archived_at = b.archived ? new Date().toISOString() : null;
  /* `read: true` stamps the first open and later opens leave it alone — the column
     answers "when did we first see this", which a re-stamp would destroy. `read:
     false` is a deliberate mark-as-unread and does clear it. */
  if (b.read === true)  patch.read_at = new Date().toISOString();
  if (b.read === false) patch.read_at = null;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  const admin = createAdminClientFor(user.id);

  /* Scoped by tenant as well as id. The admin client bypasses RLS, so the id on its
     own would address any row in the table. */
  let q = admin
    .from("inbound_emails")
    .update(patch)
    .eq("id", params.id)
    .eq("tenant_id", me.tenant_id);

  /* Do not overwrite an existing first-open stamp. */
  if (b.read === true) q = q.is("read_at", null);

  const { data, error } = await q.select("id, read_at, starred, snoozed_until, archived_at");

  if (error) {
    console.error("[inbound-emails/state]", error.message);
    return NextResponse.json({ error: "Could not update this email." }, { status: 500 });
  }

  /* Zero rows from a read-stamp is the normal "already read" case, not a failure.
     For anything else it means the email is not this tenant's. */
  if ((data?.length ?? 0) === 0 && !(b.read === true && Object.keys(patch).length === 1)) {
    return NextResponse.json({ error: "That email is not in your inbox." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, row: data?.[0] ?? null });
}
