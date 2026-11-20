/**
 * Consent form POST (from /mcp/authorize). Cookie session — so NO open CORS here, and the
 * Origin must be our own (CSRF). The signed ticket pins the user who saw the screen.
 * Allow → a pending grant + one-use code, 303 back to Claude. Cancel → error=access_denied.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { trustedOrigin } from "@/lib/app-url";
import { mcpEnabled, mcpSecret, mcpWriteEnabled } from "@/lib/mcp/config";
import { nowSeconds } from "@/lib/mcp/crypto";
import { mcpDbFromClient } from "@/lib/mcp/db";
import { readClient } from "@/lib/mcp/oauth/clients";
import { readTicket, redirectWith } from "@/lib/mcp/oauth/consent";
import { createPendingGrant, normaliseScope } from "@/lib/mcp/oauth/grants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(message: string, status = 400): Response {
  const safe = message.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c);
  return new Response(`<!doctype html><meta charset="utf-8"><title>Connect Claude</title><p style="font-family:sans-serif;max-width:32rem;margin:4rem auto">${safe}</p>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** "aal2" when the session token says so (two-step sign-in done), else "aal1". */
function aalOf(accessToken: string | undefined): "aal1" | "aal2" {
  try {
    const p: unknown = JSON.parse(Buffer.from((accessToken ?? "").split(".")[1] ?? "", "base64url").toString("utf8"));
    return p && typeof p === "object" && (p as { aal?: unknown }).aal === "aal2" ? "aal2" : "aal1";
  } catch {
    return "aal1";
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!mcpEnabled()) return new Response(null, { status: 404 });
  const secret = mcpSecret();
  if (!secret) return page("The Claude connector is not set up on this server yet. Tell the person who runs deploys.", 503);

  /* CSRF: a form post from our own page carries our Origin. */
  const own = new URL(trustedOrigin(req.headers)).origin;
  const from = req.headers.get("origin");
  if (from !== own) return page("This request did not come from the ResellerOS consent page. Start again from Claude.", 403);

  const form = await req.formData();
  const ticket = readTicket(String(form.get("ticket") ?? ""), secret, nowSeconds());
  if (!ticket) return page("This consent screen expired (10 minutes). Start again from Claude.");
  const client = readClient(ticket.c, secret);
  if (!client || !client.redirectUris.includes(ticket.r)) return page("This connection request is not valid. Start again from Claude.");

  if (form.get("decision") !== "allow") {
    return NextResponse.redirect(redirectWith(ticket.r, { error: "access_denied", error_description: "The person cancelled.", state: ticket.st }), 303);
  }

  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user || auth.user.id !== ticket.u) return page("You are signed in as someone else than the person who opened this screen. Start again from Claude.", 403);
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", auth.user.id).maybeSingle();
  if (!me || me.role === "personal") return page("This ResellerOS account cannot use the Claude connector.", 403);
  const { data: sess } = await supabase.auth.getSession();

  const db = mcpDbFromClient(supabase as unknown as SupabaseClient, me.tenant_id);
  const scope = normaliseScope(ticket.sc + (form.get("allow_write") === "on" ? " mcp:write" : ""), mcpWriteEnabled() && form.get("allow_write") === "on");
  const r = await createPendingGrant(db, {
    grantId: randomUUID(), userId: auth.user.id, email: auth.user.email ?? "", aal: aalOf(sess?.session?.access_token),
    clientId: client.clientId, clientName: client.name, redirectUri: ticket.r, scope, codeChallenge: ticket.ch,
  }, secret);
  if ("error" in r) {
    return page(`Could not connect: ${r.error_description} If you use two-step sign-in, finish it in the app first, then try again.`, 503);
  }
  return NextResponse.redirect(redirectWith(ticket.r, { code: r.code, state: ticket.st, iss: own }), 303);
}
