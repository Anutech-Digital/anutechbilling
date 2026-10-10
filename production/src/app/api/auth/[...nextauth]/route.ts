/**
 * Auth.js endpoints (/api/auth/signin, /callback/google, /session, /csrf, /signout, /providers).
 * Live only with AUTH_PROVIDER=authjs; with GoTrue they answer 404 as the path did before.
 * The app's own /api/auth/* routes (signup, onboarding, verify-email, …) are static siblings
 * and take precedence over this catch-all.
 */
import type { NextRequest } from "next/server";
import { handlers } from "@/server/auth/authjs";
import { authjsOff } from "@/server/auth/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return authjsOff() ?? handlers.GET(req);
}

export async function POST(req: NextRequest) {
  return authjsOff() ?? handlers.POST(req);
}
