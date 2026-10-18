/**
 * POST /api/agent — the website's bridge to the app's public AI sales agent.
 *
 * The widget talks to its own origin and this route hands the messages array, untouched, to
 * the app's /api/public/agent/chat handler. Validation, caps, the facts page and the money
 * guard all live there (production/src/lib/ai/public-sales-chat.ts), because a guard split
 * across two places is a guard that drifts.
 *
 * R-1598 (18 Oct 2026): handed over IN-PROCESS on this deployment (site/lib/app-forward.ts).
 * It used to call the site config's app URL over the internet, which defaulted to the LIVE
 * domain because no build set that variable — so staging chat leads were filed
 * in the live app. A cross-origin hop now needs the server-side RESELLEROS_FORWARD_URL, and a
 * non-production host is never forwarded into production.
 */
import { NextResponse, type NextRequest } from "next/server";
import { deliverToApp } from "@/site/lib/app-forward";
import { POST as publicAgentChat } from "@/app/api/public/agent/chat/route";

const AGENT_API = "/api/public/agent/chat";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "malformed" }, { status: 400 });
  }

  try {
    const res = await deliverToApp({
      req,
      path: AGENT_API,
      local: publicAgentChat,
      payload: body,
      /* Only for a configured cross-origin hop. The widget shows a typing indicator against
         this — a hung upstream must become a stated failure, not a forever-spinner. The app's
         own Gemini timeout is 20s; with the overload retry and the fallback model (4 Oct 2026)
         the worst case is longer. */
      timeoutMs: 45_000,
      tag: "agent",
    });
    if (!res.ok) {
      return NextResponse.json({ error: "agent unavailable" }, { status: 502 });
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[agent] handler failed:", err);
    return NextResponse.json({ error: "agent unavailable" }, { status: 502 });
  }
}
