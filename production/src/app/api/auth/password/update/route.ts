/**
 * POST /api/auth/password/update { password } — a signed-in user sets a new password
 * (supabase.auth.updateUser({ password }) on the GoTrue path).
 */
import type { NextRequest } from "next/server";
import { checkNewPassword } from "@/lib/auth/password-rules";
import { updateUser } from "@/server/auth/accounts";
import { currentAuthUser } from "@/server/auth/compat";
import { authjsOff, noStore, readJson } from "@/server/auth/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const off = authjsOff();
  if (off) return off;
  const me = await currentAuthUser();
  if (!me) return noStore({ error: "Sign in again — your session has ended." }, 401);
  const { password } = await readJson(req);
  if (typeof password !== "string") return noStore({ error: "Enter a new password." }, 400);
  const problem = checkNewPassword(password);
  if (problem) return noStore({ error: problem.message }, 400);
  const user = await updateUser(me.user.id, { password });
  return noStore({ ok: true, user });
}
