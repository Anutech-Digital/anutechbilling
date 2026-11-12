/**
 * R-2687 (G-SOCIAL v2): the activity list — every thing the AI or a person did on the company's
 * social accounts, newest first. Written from the routes (person, inside withTenant) and from the
 * crons (AI / system, admin client). Reading is for owner / manager / marketing (RLS).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withTenant, type TenantSession } from "@/server/db";

export type ActivityActor = "ai" | "person" | "system";
export type ActivityResult = "ok" | "failed" | "waiting";
export interface ActivityLine {
  actor: ActivityActor; platform?: string | null; action: string; detail?: string;
  contentId?: string | null; result?: ActivityResult;
}
export interface ActivityRow {
  id: string; at: string; actor: ActivityActor; user_name: string | null; platform: string | null;
  action: string; detail: string; content_id: string | null; result: ActivityResult;
}

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** A person's action, inside their own tenant (RLS insert policy). Never throws — the list must not break the action. */
export async function logPersonActivity(session: TenantSession, line: Omit<ActivityLine, "actor"> & { actor?: ActivityActor }): Promise<void> {
  try {
    await withTenant(session, (tx) => tx.$executeRaw`
      insert into public.social_activity (tenant_id, actor, user_id, platform, action, detail, content_id, result)
      values (${session.tenantId}::uuid, ${line.actor ?? "person"}, ${line.actor === "ai" ? null : session.userId}::uuid, ${line.platform ?? null},
        ${clip(line.action, 60)}, ${clip(line.detail, 500)}, ${line.contentId ?? null}::uuid, ${line.result ?? "ok"})`);
  } catch (e) {
    console.error("[social-activity] person line not written", e instanceof Error ? e.message : "unknown");
  }
}

/** An AI / system line from a cron (service role). Never throws. */
export async function logSystemActivity(admin: SupabaseClient, tenantId: string, line: ActivityLine): Promise<void> {
  const { error } = await admin.from("social_activity").insert({
    tenant_id: tenantId, actor: line.actor, platform: line.platform ?? null, action: clip(line.action, 60),
    detail: clip(line.detail, 500), content_id: line.contentId ?? null, result: line.result ?? "ok",
  });
  if (error) console.error("[social-activity] system line not written", error.message);
}

export async function listActivity(session: TenantSession, limit = 60): Promise<ActivityRow[]> {
  return withTenant(session, (tx) => tx.$queryRaw<ActivityRow[]>`
    select a.id, a.at, a.actor, u.full_name as user_name, a.platform, a.action, a.detail, a.content_id, a.result
    from public.social_activity a left join public.users u on u.id = a.user_id
    where a.tenant_id = ${session.tenantId}::uuid
    order by a.at desc limit ${Math.max(1, Math.min(200, limit))}`);
}

/** "Stop all AI": true while the company stopped the AI. */
export async function aiPausedFor(session: TenantSession): Promise<boolean> {
  const rows = await withTenant(session, (tx) => tx.$queryRaw<{ ai_paused: boolean }[]>`
    select ai_paused from public.social_content_settings where tenant_id = ${session.tenantId}::uuid`);
  return Boolean(rows[0]?.ai_paused);
}
