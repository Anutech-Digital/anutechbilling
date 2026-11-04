/**
 * R-2175: `npm run dev:local` must make the data gateway checkable on localhost.
 *
 * R-2125's checker found every gateway call answering 500 PGRST300 "Server lacks JWT secret":
 * dev-local.mjs blanks every .env.local key outside ALLOW (right — the .env.local value is a
 * real environment's secret) but never set the LOCAL stack's JWT secret in its place. And local
 * GoTrue signs sessions ES256, which identity.ts only accepts with the local public keys.
 *
 * The script runs on import (it spawns `supabase status` and next), so this reads its source:
 *   · SUPABASE_JWT_SECRET comes from `supabase status` (JWT_SECRET), never from .env.local;
 *   · GATEWAY_LOCAL_JWKS is the local API's jwks.json, public keys only;
 *   · neither name is on ALLOW (a live value must never pass through).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../scripts/dev-local.mjs", import.meta.url), "utf8");
const allowBlock = /const ALLOW = new Set\(\[([\s\S]*?)\]\);/.exec(src)?.[1] ?? "";

describe("dev:local hands the gateway its LOCAL JWT material (R-2175)", () => {
  it("reads JWT_SECRET from the local `supabase status`", () => {
    expect(src).toMatch(/get\("JWT_SECRET"\)/);
    expect(src).toMatch(/SUPABASE_JWT_SECRET:\s*sb\.jwtSecret/);
  });

  it("passes the local stack's public signing keys, fetched from the verified-local API url", () => {
    expect(src).toMatch(/\/auth\/v1\/\.well-known\/jwks\.json/);
    expect(src).toMatch(/GATEWAY_LOCAL_JWKS/);
    /* private parts are stripped before they reach the env */
    expect(src).toMatch(/"d" in k|\bd:\s*_d\b|delete [a-z]+\.d\b/);
  });

  it("never lets the .env.local value through", () => {
    expect(allowBlock).not.toMatch(/SUPABASE_JWT_SECRET|GATEWAY_LOCAL_JWKS/);
  });
});
