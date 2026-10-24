/**
 * R-1439 (galat 17 Oct, Pawan): "Switch account (signs you out)" still did nothing.
 *
 * The menu posts a form to /auth/sign-out. The route answered 303 to an ABSOLUTE URL built
 * from NEXT_PUBLIC_APP_URL whenever the request host was not on the allowlist (a production
 * build on localhost:3001, a staging hostname the list does not carry). The app's CSP has
 * `form-action 'self'`, and Chrome applies form-action to the redirect too — a redirect to
 * another origin is blocked, so the click looked dead. The answer must stay on the origin
 * the form was posted from: a relative Location.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const signOut = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { signOut } }) }));

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  signOut.mockClear();
});

describe("POST /auth/sign-out (R-1439)", () => {
  it("signs out and sends the browser to /login on the SAME origin, whatever NEXT_PUBLIC_APP_URL says", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reselleros.anutech.in");
    vi.stubEnv("NODE_ENV", "production");
    const res = await POST();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("without NEXT_PUBLIC_APP_URL too — the answer never names a host", async () => {
    const res = await POST();
    expect(res.headers.get("location")).toBe("/login");
  });
});
