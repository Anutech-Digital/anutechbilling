/**
 * AGENT_QUEUE_TOKEN — the one check every /api/agent/* route makes (R-739, 23 Oct 2026).
 *
 * The token belongs to Pardeep's AI routine (feedback queue → board cards → "fixed" / "checked"
 * ticks, page-test results). Until R-739 it was a single static token that read and wrote EVERY
 * company's feedback: a leak of it was a leak of every tenant's bug reports. Now:
 *
 *   - SCOPE. It reaches only the workspaces in AGENT_QUEUE_TENANT_IDS (comma-separated uuids).
 *     Not set → only the platform company (Anutech, CLAUDE.md §4a) — never "all". A list with
 *     nothing valid in it refuses with a message naming the variable (§24), it does not widen.
 *   - GUESSING. Wrong tokens are counted per caller IP; past the limit the answer is 429 with
 *     Retry-After, so the token cannot be brute-forced from one address.
 *   - Fails closed: no token configured → 503, as before.
 */
import { NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { platformTenantId } from "@/lib/automation/jobs";
import { clientIp, rateLimit } from "./rate-limit";

export const AGENT_SCOPE_ENV = "AGENT_QUEUE_TENANT_IDS";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Wrong-token tries per IP before 429. The routine itself never sends a wrong token. */
const BAD_TOKEN_LIMIT = { limit: 20, windowMs: 10 * 60_000 } as const;

/** The workspaces the agent token may read or write. Empty = refuse. */
export function agentTenantScope(): string[] {
  const raw = process.env[AGENT_SCOPE_ENV]?.trim();
  if (!raw) return [platformTenantId()];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => UUID.test(s)))];
}

export type AgentAuth = { ok: true; tenantIds: string[] } | { ok: false; response: NextResponse };

export function authorizeAgent(req: Request): AgentAuth {
  const expected = process.env.AGENT_QUEUE_TOKEN?.trim();
  if (!expected) {
    return { ok: false, response: NextResponse.json({ error: "agent queue not configured" }, { status: 503 }) };
  }
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    const tries = rateLimit(`agent-token-bad:${clientIp(req.headers)}`, BAD_TOKEN_LIMIT);
    if (!tries.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: `Too many wrong agent tokens from this address. Wait ${tries.retryAfterSec} seconds, then call again with the token from ~/.claude/secrets/agent-queue-token.` },
          { status: 429, headers: { "retry-after": String(tries.retryAfterSec) } },
        ),
      };
    }
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const tenantIds = agentTenantScope();
  if (tenantIds.length === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `${AGENT_SCOPE_ENV} has no valid workspace id, so the agent token may not touch any feedback. Set it to the workspace uuids (comma-separated) the AI routine should see, or remove it to use the platform company only.` },
        { status: 503 },
      ),
    };
  }
  return { ok: true, tenantIds };
}
