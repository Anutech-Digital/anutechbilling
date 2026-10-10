/**
 * POST /api/auth/password/forgot { email } — emails a one-hour reset link (replaces GoTrue's
 * resetPasswordForEmail). Always the same answer, so it never reveals whether an account exists.
 */
import type { NextRequest } from "next/server";
import { authjsOff, limited, noStore, publicOrigin, readJson } from "@/server/auth/http";
import { sendRecoveryLink } from "@/server/auth/recovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const off = authjsOff() ?? (await limited(req, "forgot"));
  if (off) return off;
  const { email } = await readJson(req);
  if (typeof email === "string" && email.includes("@")) {
    try {
      await sendRecoveryLink(email, publicOrigin(req));
    } catch (e) {
      console.error("[auth/forgot] could not send reset link:", (e as Error).message);
    }
  }
  return noStore({ ok: true, message: "If that address has an account, a reset link is on its way." });
}
