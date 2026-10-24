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
import { siteVisitorLimit, waitPhrase } from "@/lib/security/rate-limit";

const AGENT_API = "/api/public/agent/chat";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "malformed" }, { status: 400 });
  }

  /* R-1549: this visitor's own count (per IP) — the middleware does not count /api/agent and the
     handler below runs in-process, so without this there was no limit, and before R-1598 every
     visitor shared the server's one bucket. Every message here is a paid model call. */
  const limit = await siteVisitorLimit("agent", req.headers);
  if (!limit.ok) {
    const wait = waitPhrase(limit.retryAfterSec);
    return NextResponse.json(
      {
        error: "rate_limited",
        retryAfterSec: limit.retryAfterSec,
        reply:
          `You have sent too many messages in a short time, so I could not answer this one. ` +
          `Please wait ${wait} and send it again — or use the Get a quote page, or message us on WhatsApp.`,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
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
