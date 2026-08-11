/**
 * Attendance selfie retention (DPDP storage-limitation).
 *
 * For every tenant, deletes attendance selfies older than that tenant's
 * selfie_retention_days, plus ALL selfies of inactive (exited) employees.
 * Attendance rows stay — only the face images are erased. Runs daily.
 *
 * Auth: Authorization: Bearer <CRON_SECRET> (same as the other crons).
 */
import "@/lib/sentry";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RetentionResult {
  ran_at: string;
  tenants: number;
  images_deleted: number;
  rows_cleared: number;
  errors: string[];
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request): Promise<NextResponse<RetentionResult | { error: string }>> {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const result: RetentionResult = { ran_at: new Date().toISOString(), tenants: 0, images_deleted: 0, rows_cleared: 0, errors: [] };

  const { data: settings, error: sErr } = await supabase
    .from("attendance_settings").select("tenant_id, selfie_retention_days");
  if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });

  // IST today, for the cutoff date math.
  const istToday = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

  for (const s of settings ?? []) {
    result.tenants += 1;
    const days = s.selfie_retention_days ?? 180;
    const cutoff = new Date(new Date(istToday + "T00:00:00Z").getTime() - days * 86400000).toISOString().slice(0, 10);
    try {
      // Rows past retention with a selfie, OR selfies of inactive employees.
      const { data: inactive } = await supabase
        .from("employees").select("id").eq("tenant_id", s.tenant_id).eq("is_active", false);
      const inactiveIds = (inactive ?? []).map((e) => e.id);

      const { data: oldRows } = await supabase
        .from("attendance")
        .select("id, employee_id, work_date, selfie_in, selfie_out")
        .eq("tenant_id", s.tenant_id)
        .or(`work_date.lt.${cutoff}${inactiveIds.length ? `,employee_id.in.(${inactiveIds.join(",")})` : ""}`)
        .not("selfie_in", "is", null);

      const { data: oldRows2 } = await supabase
        .from("attendance")
        .select("id, employee_id, work_date, selfie_in, selfie_out")
        .eq("tenant_id", s.tenant_id)
        .or(`work_date.lt.${cutoff}${inactiveIds.length ? `,employee_id.in.(${inactiveIds.join(",")})` : ""}`)
        .not("selfie_out", "is", null);

      const rowMap = new Map<string, { selfie_in: string | null; selfie_out: string | null }>();
      for (const r of [...(oldRows ?? []), ...(oldRows2 ?? [])]) {
        rowMap.set(r.id, { selfie_in: r.selfie_in, selfie_out: r.selfie_out });
      }
      const paths = [...rowMap.values()].flatMap((r) => [r.selfie_in, r.selfie_out].filter(Boolean) as string[]);
      if (paths.length) {
        // Storage remove tolerates batches; chunk to be safe.
        for (let i = 0; i < paths.length; i += 100) {
          const { error: rmErr } = await supabase.storage.from("attendance-selfies").remove(paths.slice(i, i + 100));
          if (rmErr) result.errors.push(`${s.tenant_id}: ${rmErr.message}`);
        }
        result.images_deleted += paths.length;
        const ids = [...rowMap.keys()];
        for (let i = 0; i < ids.length; i += 200) {
          await supabase.from("attendance").update({ selfie_in: null, selfie_out: null }).in("id", ids.slice(i, i + 200));
        }
        result.rows_cleared += ids.length;
      }
    } catch (e) {
      result.errors.push(`${s.tenant_id}: ${(e as Error).message}`);
    }
  }

  return NextResponse.json(result);
}
