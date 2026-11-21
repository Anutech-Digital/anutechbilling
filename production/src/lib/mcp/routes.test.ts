/**
 * The HTTP surface: everything is 404 while MCP_ENABLED is off; with it on, metadata is served,
 * /api/mcp demands a Bearer token and points at the resource metadata, registration and the
 * token endpoint validate, and the consent POST refuses a cross-site origin.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiter } from "@/lib/security/rate-limit";
import * as mcpRoute from "@/app/api/mcp/route";
import * as register from "@/app/api/mcp/oauth/register/route";
import * as token from "@/app/api/mcp/oauth/token/route";
import * as revoke from "@/app/api/mcp/oauth/revoke/route";
import * as authorize from "@/app/api/mcp/oauth/authorize/route";
import { registerClient } from "@/lib/mcp/oauth/clients";
import { continueTo, issueTicket } from "@/lib/mcp/oauth/consent";
import * as asMeta from "@/app/.well-known/oauth-authorization-server/route";
import * as prMeta from "@/app/.well-known/oauth-protected-resource/[[...path]]/route";

const ORIGIN = "http://localhost:3001";
const req = (path: string, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, { ...init, headers: { host: "localhost:3001", ...(init.headers ?? {}) } });

beforeEach(() => {
  resetRateLimiter();
  process.env.MCP_OAUTH_SECRET = "route-test-secret-route-test-secret-01";
});
afterEach(() => {
  delete process.env.MCP_ENABLED;
  delete process.env.MCP_OAUTH_SECRET;
});

describe("MCP_ENABLED off (default)", () => {
  it("every endpoint answers 404", async () => {
    expect((await mcpRoute.POST(req("/api/mcp", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await register.POST(req("/api/mcp/oauth/register", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await token.POST(req("/api/mcp/oauth/token", { method: "POST", body: "" }))).status).toBe(404);
    expect((await revoke.POST(req("/api/mcp/oauth/revoke", { method: "POST", body: "" }))).status).toBe(404);
    expect((await authorize.POST(req("/api/mcp/oauth/authorize", { method: "POST" }))).status).toBe(404);
    expect(asMeta.GET(req("/.well-known/oauth-authorization-server")).status).toBe(404);
    expect(prMeta.GET(req("/.well-known/oauth-protected-resource/api/mcp")).status).toBe(404);
  });
});

describe("MCP_ENABLED on", () => {
  beforeEach(() => { process.env.MCP_ENABLED = "true"; });

  it("refuses to run without the signing secret", async () => {
    delete process.env.MCP_OAUTH_SECRET;
    expect((await mcpRoute.POST(req("/api/mcp", { method: "POST" }))).status).toBe(503);
  });

  it("serves both metadata documents", async () => {
    const as = await asMeta.GET(req("/.well-known/oauth-authorization-server")).json();
    expect(as).toMatchObject({
      issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/mcp/authorize`, token_endpoint: `${ORIGIN}/api/mcp/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/mcp/oauth/register`, code_challenge_methods_supported: ["S256"],
    });
    const pr = await prMeta.GET(req("/.well-known/oauth-protected-resource/api/mcp")).json();
    expect(pr).toMatchObject({ resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN] });
  });

  it("/api/mcp without a token is 401 with a resource_metadata challenge", async () => {
    const r = await mcpRoute.POST(req("/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
  });

  it("/api/mcp with a forged token is 401", async () => {
    const r = await mcpRoute.POST(req("/api/mcp", { method: "POST", headers: { authorization: "Bearer mcpat.eyJ9.forged" } }));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("registers a public client and refuses a bad redirect", async () => {
    const ok = await register.POST(req("/api/mcp/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" }) }));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ token_endpoint_auth_method: "none", client_name: "Claude" });
    const bad = await register.POST(req("/api/mcp/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.test/cb"] }) }));
    expect(bad.status).toBe(400);
  });

  it("token endpoint: unknown client 401, unknown grant type 400", async () => {
    const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
    expect((await token.POST(req("/api/mcp/oauth/token", form({ grant_type: "authorization_code", client_id: "nope" })))).status).toBe(401);
    const reg = await (await register.POST(req("/api/mcp/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["https://claude.ai/cb"] }) }))).json();
    expect((await token.POST(req("/api/mcp/oauth/token", form({ grant_type: "password", client_id: reg.client_id })))).status).toBe(400);
    const bad = await token.POST(req("/api/mcp/oauth/token", form({ grant_type: "authorization_code", client_id: reg.client_id, code: "mcpcode.x.y", code_verifier: "v".repeat(43), redirect_uri: "https://claude.ai/cb" })));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("revoke always answers 200 (RFC 7009), even for junk", async () => {
    expect((await revoke.POST(req("/api/mcp/oauth/revoke", { method: "POST", body: "token=junk" }))).status).toBe(200);
  });

  it("consent POST refuses another site's origin (CSRF)", async () => {
    const r = await authorize.POST(req("/api/mcp/oauth/authorize", { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" }, body: "decision=allow" }));
    expect(r.status).toBe(403);
  });

  /* R-2974: the answer must never be a redirect — CSP form-action 'self' makes Chrome drop a 303
     to claude.ai after a form POST, and Allow looked dead. A same-origin page continues instead. */
  it("consent POST (Cancel) answers a same-origin page that continues to Claude with access_denied — no Location", async () => {
    process.env.MCP_ENABLED = "true";
    const secret = process.env.MCP_OAUTH_SECRET!;
    const reg = registerClient({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude", token_endpoint_auth_method: "none" }, secret, 1_000);
    if (!reg.ok) throw new Error("register failed");
    const ticket = issueTicket("11111111-1111-4111-8111-111111111111", {
      client: reg.client, redirectUri: "https://claude.ai/api/mcp/auth_callback", codeChallenge: "c".repeat(43), state: "st&<1>", scope: "mcp:read",
    }, secret, Math.floor(Date.now() / 1000));
    const r = await authorize.POST(req("/api/mcp/oauth/authorize", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket, decision: "deny" }).toString(),
    }));
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(html).toContain('<noscript><meta http-equiv="refresh"');
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain("https://claude.ai/api/mcp/auth_callback?error=access_denied");
    expect(html).toContain("state=st%26%3C1%3E");
    expect(html).toContain("location.replace(");
    expect(html).toContain("Continue to Claude");
  });

  it("continueTo escapes the target and the client name (no HTML or script break-out)", async () => {
    const r = continueTo("https://claude.ai/cb?state=a\"b<c>&d", "<img src=x onerror=alert(1)>");
    const html = await r.text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('href="https://claude.ai/cb?state=a&quot;b&lt;c&gt;&amp;d"');
    expect(html).toContain('location.replace("https://claude.ai/cb?state=a\\"b\\u003cc>&d")');
  });

  it("answers CORS preflight", () => {
    expect(mcpRoute.OPTIONS().status).toBe(204);
    expect(mcpRoute.OPTIONS().headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});
