/**
 * MCP connector — OAuth surface against a running app (docs/MCP.md §4).
 * Needs MCP_ENABLED=true and MCP_OAUTH_SECRET on the server; skips itself when the connector is
 * off (the metadata URL answers 404), so it never fails a run where the feature is not switched on.
 *
 *   MCP_ENABLED=true MCP_OAUTH_SECRET=<32+ chars> npx playwright test e2e/mcp-auth.spec.ts --project=chromium
 */
import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

const REDIRECT = "http://localhost:6274/oauth/callback";

test.describe("MCP OAuth", () => {
  test.beforeEach(async ({ request }) => {
    const r = await request.get("/.well-known/oauth-authorization-server");
    test.skip(r.status() === 404, "MCP_ENABLED is off on this server");
  });

  test("advertises metadata and challenges an unauthenticated MCP call", async ({ request, baseURL }) => {
    const as = await (await request.get("/.well-known/oauth-authorization-server")).json();
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.registration_endpoint).toMatch(/\/api\/mcp\/oauth\/register$/);
    const pr = await (await request.get("/.well-known/oauth-protected-resource/api/mcp")).json();
    expect(pr.resource).toBe(`${baseURL}/api/mcp`);

    const mcp = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(mcp.status()).toBe(401);
    expect(mcp.headers()["www-authenticate"]).toContain("resource_metadata=");
  });

  test("registers a client; signed-out authorize goes to login and back; a fake code is refused", async ({ request, page }) => {
    const reg = await request.post("/api/mcp/oauth/register", { data: { redirect_uris: [REDIRECT], client_name: "E2E Inspector" } });
    expect(reg.status()).toBe(201);
    const { client_id } = await reg.json();

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const qs = new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "e2e" });
    await page.goto(`/mcp/authorize?${qs}`);
    await expect(page).toHaveURL(/\/login\?next=%2Fmcp%2Fauthorize/);

    const bad = await request.post("/api/mcp/oauth/token", {
      form: { grant_type: "authorization_code", client_id, code: "mcpcode.e30.x", code_verifier: verifier, redirect_uri: REDIRECT },
    });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toBe("invalid_grant");
  });

  test("an unregistered redirect address is shown as an error, never followed", async ({ page, request }) => {
    const { client_id } = await (await request.post("/api/mcp/oauth/register", { data: { redirect_uris: [REDIRECT] } })).json();
    const qs = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://evil.example/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256" });
    await page.goto(`/mcp/authorize?${qs}`);
    await expect(page.getByText("Could not connect Claude")).toBeVisible();
    expect(page.url()).not.toContain("evil.example/cb?");
  });
});
