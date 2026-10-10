/** Small shared pieces for the Auth.js API routes under src/app/api/auth/. */
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimitShared } from "@/lib/security/rate-limit";
import { authProvider } from "./authjs";

/** Public host for links — never `new URL(request.url).origin` (the container address on Cloud Run). */
export function publicOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : (process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ?? "");
}

/** These routes exist only when login runs on Auth.js. With GoTrue they answer 404, as before. */
export function authjsOff(): NextResponse | null {
  return authProvider() === "authjs" ? null : NextResponse.json({ error: "not found" }, { status: 404 });
}

export function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Per-IP limit for unauthenticated auth endpoints (password reset, etc.). */
export async function limited(req: NextRequest, bucket: string, limit = 5, windowMs = 15 * 60_000): Promise<NextResponse | null> {
  const r = await rateLimitShared(`auth:${bucket}:${clientIp(req.headers)}`, { limit, windowMs });
  return r.ok ? null : noStore({ error: "Too many attempts — wait a few minutes and try again." }, 429);
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
