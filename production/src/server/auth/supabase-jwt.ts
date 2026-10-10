/**
 * The bridge between Auth.js and everything that still speaks "Supabase session token": after
 * an Auth.js sign-in, the app mints the same short-lived HS256 token GoTrue used to issue
 * (same secret, same claims). The data gateway and the security policies keep working unchanged,
 * and so does Storage on the VM until files move to Cloud Storage.
 *
 * Minted only on the server, only for the signed-in user of the current Auth.js session,
 * valid 10 minutes. Same trust as GoTrue had: whoever holds SUPABASE_JWT_SECRET can mint.
 */
import "server-only";
import { createHmac } from "node:crypto";

export const MINTED_TTL_SECONDS = 600;

export function mintSupabaseJwt(input: { userId: string; email: string; aal: "aal1" | "aal2" }, nowMs = Date.now()): { token: string; expiresAt: number } {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("SUPABASE_JWT_SECRET is not set");
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + MINTED_TTL_SECONDS;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({
    aud: "authenticated", role: "authenticated", sub: input.userId, email: input.email,
    aal: input.aal, amr: [{ method: input.aal === "aal2" ? "totp" : "password", timestamp: iat }],
    iss: "resellersos-authjs", iat, exp, session_id: `authjs-${input.userId}`,
  });
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return { token: `${head}.${body}.${sig}`, expiresAt: exp };
}
