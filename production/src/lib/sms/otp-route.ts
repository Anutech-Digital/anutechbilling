/**
 * R-1903: the pieces the /api/settings/mobile routes share — the signed-in caller, the RPC
 * call, and turning a database refusal into a §24 message. Works with either login provider:
 * createClient() answers auth.getUser() from GoTrue or Auth.js (server/auth/compat.ts).
 */
import "server-only";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export interface RpcResult<T> { data: T | null; error: { message?: string; code?: string } | null }
export interface OtpRpcClient {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult<T>>;
}

export function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export const SESSION_ENDED = "Your session has ended — sign in again, then verify your mobile number.";

/** The session client and its user id, or null when nobody is signed in. */
export async function otpCaller(): Promise<{ db: ReturnType<typeof createClient>; userId: string } | null> {
  const db = createClient();
  const { data } = await db.auth.getUser();
  const id = data?.user?.id;
  return id ? { db, userId: id } : null;
}

export function rpcClient(db: unknown): OtpRpcClient {
  return db as OtpRpcClient;
}

/** A raised error from the RPCs: 28000 = not signed in to a company; anything else = our fault. */
export function rpcFailure(error: { message?: string; code?: string }): NextResponse {
  if (error.code === "28000") {
    const msg = (error.message ?? "").replace(/^R-1903:\s*/, "") || SESSION_ENDED;
    return noStore({ error: msg }, 403);
  }
  return noStore({
    error: "The code could not be saved, so nothing was sent. Try again in a minute; if it keeps failing, ask your owner.",
  }, 500);
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
