import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { createClient } from "@/lib/supabase/server";
import { socialRole } from "@/lib/marketing/social-content";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const body = z.object({ autoDrafts: z.boolean(), brief: z.string().trim().max(1000) });

export async function PUT(req: Request) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (await socialRole(session) !== "owner") return NextResponse.json({ error: "Only the owner can configure draft automation." }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid settings." }, { status: 400 });
  if (parsed.data.autoDrafts && !parsed.data.brief) return NextResponse.json({ error: "Add topics and brand guidance first." }, { status: 400 });
  try {
    const client = createClient();
    const rpc = client.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    const { error } = await rpc.call(client, "set_automation_job", { p_job: "social-drafts", p_enabled: parsed.data.autoDrafts, p_dry_run: false });
    if (error) return NextResponse.json({ error: "Could not turn on scheduled draft preparation." }, { status: 500 });
    await withTenant(session, tx => tx.$executeRaw`
      insert into public.social_content_settings (tenant_id, auto_drafts, brief, updated_by)
      values (${session.tenantId}::uuid, ${parsed.data.autoDrafts}, ${parsed.data.brief}, ${session.userId}::uuid)
      on conflict (tenant_id) do update set auto_drafts = excluded.auto_drafts, brief = excluded.brief,
        updated_by = excluded.updated_by, updated_at = now()`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not save draft automation." }, { status: 500 });
  }
}
