/**
 * R-1552 (18 Oct 2026): the cron-secret check for routes that do it themselves as well as
 * behind gatedCron (defence in depth — a route must never trust that it was reached through
 * the gate). Only `Authorization: Bearer <CRON_SECRET>`, compared in constant time.
 * No signed-in-user path: a cron works across companies, and a user belongs to one.
 *
 *   const denied = cronAuthFailure(req, process.env.CRON_SECRET); if (denied) return denied;
 *
 * The route passes the secret itself, so the route file names CRON_SECRET (the R-051 / R-732
 * ratchets read the route to see how its caller is proved).
 */
import { NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";

/** null = authorised; otherwise the response to return (503 when the secret is unset, 401 otherwise). */
export function cronAuthFailure(req: Request, secret: string | undefined): NextResponse<{ error: string }> | null {
  const expected = secret?.trim();
  if (!expected) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!timingSafeEqualStr(m?.[1]?.trim() ?? "", expected)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return null;
}
