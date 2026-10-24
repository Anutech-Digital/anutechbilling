/**
 * What every Cold Calling route needs first: who is asking, through RLS, and whether they may.
 * Returns a ready NextResponse when they may not — §24: what happened, why, what to do.
 */
import "server-only";
import { NextResponse } from "next/server";
import { getTenantSession } from "@/server/auth/session";
import { withTenant, type TenantSession } from "@/server/db";
import { resolveTelecallProvider, type TelecallProviderConfig } from "@/lib/telecall/provider";
import { COLD_CALL_ROLES, roleOf, type Run } from "./coldcall.server";

export interface ColdCallContext {
  session: TenantSession;
  run: Run;
  role: string;
}

export async function coldCallContext(): Promise<ColdCallContext | NextResponse> {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const run: Run = (fn) => withTenant(session, fn);
  const role = await roleOf(run, session.userId);
  if (!role || !(COLD_CALL_ROLES as readonly string[]).includes(role)) {
    return NextResponse.json(
      { error: "Cold Calling is for owners, managers, marketing and the sales team.", detail: "Ask the owner to change your role on the Team page." },
      { status: 403 },
    );
  }
  return { session, run, role };
}

/** The Bolna account, or a response that says how to connect it. */
export function bolnaOrError(): TelecallProviderConfig | NextResponse {
  const config = resolveTelecallProvider();
  if (!config || config.name !== "bolna") {
    return NextResponse.json(
      {
        error: "Bolna is not connected yet.",
        detail: "Ask the owner to set TELECALL_PROVIDER=bolna, BOLNA_API_KEY and BOLNA_AGENT_ID on the server (docs/telecall-bolna.md).",
      },
      { status: 409 },
    );
  }
  return config;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
