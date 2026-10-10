import { describe, expect, it } from "vitest";
import { publicSession } from "./session-public";

describe("R-528: the session the browser sees carries no token", () => {
  const token = {
    uid: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", aal: "aal2", mfa: true,
    gat: "ya29.secret-google-access", grt: "1//refresh", gexp: 9999999999, gscope: "openid https://www.googleapis.com/auth/apps.order", id_token: "eyJ.id", access_token: "x",
    refresh_token: "y", provider_token: "z", sub: "google-sub", jti: "j",
  };
  const session = {
    expires: "2026-10-16T00:00:00.000Z",
    user: { name: "Owner", email: "ignored@example.test", image: "https://example.test/a.png" },
    provider_token: "leak", access_token: "leak",
  };

  it("no key anywhere matching /token/i, and no token value anywhere", () => {
    const out = publicSession(session, token);
    const json = JSON.stringify(out);
    const keys: string[] = [];
    const walk = (o: unknown) => {
      if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { keys.push(k); walk(v); }
    };
    walk(out);
    expect(keys.filter((k) => /token/i.test(k))).toEqual([]);
    for (const secret of ["ya29", "1//refresh", "eyJ.id", "leak", "apps.order"]) expect(json).not.toContain(secret);
  });

  it("keeps exactly what the UI needs", () => {
    expect(publicSession(session, token)).toEqual({
      expires: "2026-10-16T00:00:00.000Z",
      user: { id: token.uid, email: "owner@example.test", name: "Owner", image: "https://example.test/a.png" },
      aal: "aal2",
      mfaEnrolled: true,
    });
  });

  it("signed-in without two-step → aal1; anything odd in aal → aal1", () => {
    expect(publicSession({ expires: "e" }, { uid: "u", email: "e@x.y" })).toMatchObject({ aal: "aal1", mfaEnrolled: false });
    expect(publicSession({ expires: "e" }, { uid: "u", aal: "aal9" }).aal).toBe("aal1");
  });

  it("the session callback in authjs.ts uses this allow-list (not a spread of the token)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./authjs.ts", import.meta.url), "utf8");
    const cb = src.slice(src.indexOf("async session("), src.indexOf("async session(") + 400);
    expect(cb).toContain("publicSession(session, token)");
    expect(src).not.toMatch(/session\.provider_token|provider_token\?:/);
  });

  it("/api/auth/supabase-token (also read by the browser) does not send the Google token", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../app/api/auth/supabase-token/route.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export async function GET"));
    expect(body).not.toMatch(/provider_token|providerToken/);
  });
});
