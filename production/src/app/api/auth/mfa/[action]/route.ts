/**
 * Two-step sign-in (R-048) on Auth.js:
 *   GET  /api/auth/mfa/factors   → { all, totp }
 *   GET  /api/auth/mfa/aal       → { currentLevel, nextLevel }
 *   POST /api/auth/mfa/enroll    { friendlyName? } → { id, totp: { qr_code, secret, uri } }
 *   POST /api/auth/mfa/verify    { code, factorId? } → checks the code SERVER-side (in the
 *                                 Auth.js jwt callback) and, if right, raises the session to aal2
 *   POST /api/auth/mfa/unenroll  { factorId } → removes it (needs an aal2 session if enrolled)
 */
import type { NextRequest } from "next/server";
import { unstable_update } from "@/server/auth/authjs";
import { currentAuthUser } from "@/server/auth/compat";
import { authjsOff, limited, noStore, readJson } from "@/server/auth/http";
import { enroll, listFactors, unenroll } from "@/server/auth/mfa";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ action: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const off = authjsOff();
  if (off) return off;
  const me = await currentAuthUser();
  if (!me) return noStore({ error: "Sign in again — your session has ended." }, 401);
  const { action } = await ctx.params;
  const all = await listFactors(me.user.id);
  const verified = all.filter((f) => f.status === "verified");
  if (action === "factors") return noStore({ all, totp: verified, phone: [] });
  if (action === "aal") {
    return noStore({ currentLevel: me.aal, nextLevel: verified.length ? "aal2" : "aal1", currentAuthenticationMethods: [] });
  }
  return noStore({ error: "not found" }, 404);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const off = authjsOff();
  if (off) return off;
  const me = await currentAuthUser();
  if (!me) return noStore({ error: "Sign in again — your session has ended." }, 401);
  const { action } = await ctx.params;
  const body = await readJson(req);

  if (action === "enroll") {
    const r = await enroll(me.user.id, me.user.email, typeof body.friendlyName === "string" ? body.friendlyName : undefined);
    return noStore(r);
  }

  if (action === "verify") {
    const tooMany = await limited(req, `mfa:${me.user.id}`, 10, 5 * 60_000);
    if (tooMany) return tooMany;
    if (typeof body.code !== "string") return noStore({ error: "Type the 6-digit code from your authenticator app." }, 400);
    const session = await unstable_update({ mfaCode: body.code, factorId: typeof body.factorId === "string" ? body.factorId : undefined } as never);
    if (session?.aal !== "aal2") {
      return noStore({ error: "That code did not match — check the time on your phone and type the newest code." }, 400);
    }
    return noStore({ ok: true, aal: "aal2" });
  }

  if (action === "unenroll") {
    if (typeof body.factorId !== "string") return noStore({ error: "Which factor? (factorId missing)" }, 400);
    if (me.mfaEnrolled && me.aal !== "aal2") {
      return noStore({ error: "Confirm with a code from your authenticator app first, then turn two-step sign-in off." }, 403);
    }
    const ok = await unenroll(me.user.id, body.factorId);
    await unstable_update({ refreshMfa: true } as never);
    return ok ? noStore({ ok: true }) : noStore({ error: "That factor was not found on your account." }, 404);
  }

  return noStore({ error: "not found" }, 404);
}
