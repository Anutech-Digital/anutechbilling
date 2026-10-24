/**
 * POST /api/public/unsubscribe  { t: tenantId, e: email, s: signature, c?: campaignId }
 *
 * Adds the address to email_suppressions for that company. Called by the /unsubscribe page
 * after the person presses the button — a POST, not the GET of the link itself, because
 * mail scanners and link previewers open every link in a mail and would otherwise
 * unsubscribe people who never asked.
 *
 * No login: the signature (lib/marketing/unsubscribe-token.ts) is the permission. Written
 * with the service role because the person is not a user of the app.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyUnsubscribe, normaliseEmail } from "@/lib/marketing/unsubscribe-token";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  t: z.string().uuid(),
  e: z.string().email().max(320),
  s: z.string().min(16).max(128),
  c: z.string().max(64).optional(),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "This link is incomplete — open the full link from the email." }, { status: 400 });
  }
  const { t, e, s, c } = parsed.data;
  if (!verifyUnsubscribe(t, e, s)) {
    return NextResponse.json({ error: "This link is not valid or has been changed." }, { status: 403 });
  }

  /* Untyped: the table is newer than the generated types (database.types.ts is shared). */
  const admin = createAdminClient() as unknown as { from: (t: string) => any };  // eslint-disable-line @typescript-eslint/no-explicit-any
  const { error } = await admin.from("email_suppressions").upsert(
    { tenant_id: t, email: normaliseEmail(e), reason: "unsubscribed", campaign_id: c ?? null },
    { onConflict: "tenant_id,email", ignoreDuplicates: true },
  );
  if (error) {
    console.error("[/api/public/unsubscribe] insert failed:", error);
    return NextResponse.json({ error: "Could not save right now — try again in a little while." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
