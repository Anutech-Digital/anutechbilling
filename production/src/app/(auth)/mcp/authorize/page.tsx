/**
 * /mcp/authorize — the consent screen Claude opens when the owner adds the ResellerOS connector.
 * Signed out → /login, then back here. Shows who is connecting, to which company, with what
 * power, and posts the decision to /api/mcp/oauth/authorize with a signed ticket.
 */
import type { Metadata, Route } from "next";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { trustedOrigin } from "@/lib/app-url";
import { roleLabel } from "@/lib/auth/roles";
import { mcpEnabled, mcpSecret, mcpWriteEnabled, SCOPE_WRITE } from "@/lib/mcp/config";
import { nowSeconds } from "@/lib/mcp/crypto";
import { issueTicket, parseAuthorize, redirectWith } from "@/lib/mcp/oauth/consent";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connect Claude", robots: "noindex" };

type SP = Promise<Record<string, string | string[] | undefined>>;

function flat(sp: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(sp)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

function Problem({ message }: { message: string }) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Could not connect Claude</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

export default async function McpAuthorizePage({ searchParams }: { searchParams: SP }) {
  if (!mcpEnabled()) notFound();
  const secret = mcpSecret();
  if (!secret) return <Problem message="The Claude connector is not set up on this server yet (MCP_OAUTH_SECRET is missing). Tell the person who runs deploys." />;
  const params = flat(await searchParams);
  const origin = trustedOrigin(await headers());
  const parsed = parseAuthorize(params, secret, `${origin}/api/mcp`);
  if (!parsed.ok && parsed.kind === "show") return <Problem message={parsed.message} />;
  /* The client's own (registered, exact-match) redirect URI — external, so not a typed app route. */
  if (!parsed.ok) redirect(redirectWith(parsed.redirectUri, { error: parsed.error, error_description: parsed.description, state: parsed.state }) as Route);
  const req = parsed.req;

  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
    redirect(`/login?next=${encodeURIComponent(`/mcp/authorize?${qs}`)}`);
  }
  const { data: me } = await supabase.from("users").select("full_name, role, tenant_id").eq("id", auth.user.id).maybeSingle();
  const { data: company } = me ? await supabase.from("tenants").select("name").eq("id", me.tenant_id).maybeSingle() : { data: null };
  if (!me || me.role === "personal") {
    return <Problem message="This ResellerOS account cannot use the Claude connector. Sign in with your company login." />;
  }

  const ticket = issueTicket(auth.user.id, req, secret, nowSeconds());
  const offerWrite = mcpWriteEnabled();
  const askedWrite = req.scope.split(/\s+/).includes(SCOPE_WRITE);

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Connect {req.client.name} to ResellerOS?</CardTitle>
        <CardDescription>
          It will act as <strong>{me.full_name ?? auth.user.email}</strong> ({roleLabel(me.role)}) in{" "}
          <strong>{company?.name ?? "your company"}</strong>, and see only what you can see in the app.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action="/api/mcp/oauth/authorize" className="space-y-4">
          <input type="hidden" name="ticket" value={ticket} />
          <ul className="list-disc pl-5 text-sm text-ink-2 space-y-1">
            <li>Read your queue, leads, customers, quotes, invoices, renewals and reports.</li>
            <li>Never: passwords, API keys, vault secrets, deleting anything, sending email or WhatsApp.</li>
            <li>Every request is logged. You can disconnect any time.</li>
          </ul>
          {offerWrite && (
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" name="allow_write" defaultChecked={askedWrite} className="mt-1" />
              <span>Also allow changes — add leads, notes, tasks, follow-ups and support notes. Each change is shown to you first and needs your OK.</span>
            </label>
          )}
          <div className="flex gap-3 justify-end">
            <Button type="submit" name="decision" value="deny" variant="default">Cancel</Button>
            <Button type="submit" name="decision" value="allow" variant="primary">Allow</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
