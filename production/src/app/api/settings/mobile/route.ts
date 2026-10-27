/**
 * GET /api/settings/mobile — R-1903: my mobile number and whether it is verified, for
 * Settings → Security → Mobile number. Also says whether a code can be sent at all (smsReady)
 * and whether this is a local server that shows the code on screen (devMode).
 */
import { smsGateway } from "@/lib/sms/gateway";
import { noStore, otpCaller, SESSION_ENDED } from "@/lib/sms/otp-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Row { phone: string | null; phone_verified_at: string | null }
interface LooseFrom {
  from(t: "users"): { select(c: string): { eq(k: string, v: string): { maybeSingle(): PromiseLike<{ data: Row | null; error: unknown }> } } };
}

export async function GET() {
  const me = await otpCaller();
  if (!me) return noStore({ error: SESSION_ENDED }, 401);
  const { data } = await (me.db as unknown as LooseFrom)
    .from("users").select("phone, phone_verified_at").eq("id", me.userId).maybeSingle();
  const gw = smsGateway();
  return noStore({
    phone: data?.phone ?? null,
    verifiedAt: data?.phone_verified_at ?? null,
    smsReady: gw.ready,
    devMode: gw.name === "dev",
  });
}
