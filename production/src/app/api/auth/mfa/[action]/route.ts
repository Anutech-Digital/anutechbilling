/**
 * Two-step sign-in (R-048) on Auth.js:
 *   GET  /api/auth/mfa/factors   → { all, totp }
 *   GET  /api/auth/mfa/aal       → { currentLevel, nextLevel }
 *   POST /api/auth/mfa/enroll    { friendlyName? } → { id, totp: { qr_code, secret, uri } }
 *                                 (needs an aal2 session once a verified factor exists — R-1547)
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

/** §24: what happened, why, what to do next. */
const NEED_AAL2 =
  "A new authenticator cannot be added yet — two-step sign-in is already on for your account. " +
  "Enter the code from your current authenticator first, then add the new one.";

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
    // R-1547: an account that already has two-step sign-in on adds a new authenticator only from
    // an aal2 session — otherwise a password alone could plant one and use it as the second step.
    // Read the factors from the DB, not the session flag, so a stale flag cannot let it through.
    const verified = (await listFactors(me.user.id)).some((f) => f.status === "verified");
    if (verified && me.aal !== "aal2") return noStore({ error: NEED_AAL2 }, 403);
    const r = await enroll(me.user.id, me.user.email, typeof body.friendlyName === "string" ? body.friendlyName : undefined);
    return noStore(r);
  }

  if (action === "verify") {
    const tooMany = await limited(req, `mfa:${me.user.id}`, 10, 5 * 60_000);
    if (tooMany) return tooMany;
    if (typeof body.code !== "string") return noStore({ error: "Type the 6-digit code from your authenticator app." }, 400);
    if (typeof body.factorId === "string") {
      // R-1547: the factor must be this user's own, and a NEW factor is no second step while
      // another verified factor exists and the session is still aal1 (also enforced in verifyCode).
      const all = await listFactors(me.user.id);
      const f = all.find((x) => x.id === body.factorId);
      if (!f) return noStore({ error: "That authenticator was not found on your account — start adding it again from Settings → Security." }, 404);
      if (f.status !== "verified" && me.aal !== "aal2" && all.some((x) => x.status === "verified")) {
        return noStore({ error: NEED_AAL2 }, 403);
      }
    }
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
