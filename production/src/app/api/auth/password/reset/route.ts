/**
 * POST /api/auth/password/reset { token, password } — spends a reset link and sets the new
 * password. Returns the account email so the page can sign straight in with it.
 */
import type { NextRequest } from "next/server";
import { checkNewPassword } from "@/lib/auth/password-rules";
import { authjsOff, limited, noStore, readJson } from "@/server/auth/http";
import { resetWithToken } from "@/server/auth/recovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const off = authjsOff() ?? (await limited(req, "reset", 10));
  if (off) return off;
  const { token, password } = await readJson(req);
  if (typeof token !== "string" || typeof password !== "string") {
    return noStore({ error: "This reset link is incomplete — open the link from the email again." }, 400);
  }
  const problem = checkNewPassword(password);
  if (problem) return noStore({ error: problem.message }, 400);
  const email = await resetWithToken(token, password);
  if (!email) return noStore({ error: "This reset link has expired or was already used — ask for a new one on the Forgot password page." }, 400);
  return noStore({ ok: true, email });
}
