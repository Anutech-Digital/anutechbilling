import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/* R-1548: when Auth.js refuses a login for too many wrong passwords, the login page must say
   so in plain words and offer "Forgot password" — not the same "Invalid login credentials"
   that tells the person to keep trying. */

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(async () => ({ error: "CredentialsSignin", code: "too_many_attempts", ok: false, status: 200, url: null })),
  signOut: vi.fn(),
}));

import { browserAuth, TOO_MANY_ATTEMPTS_CODE, TOO_MANY_ATTEMPTS_MESSAGE } from "@/lib/auth/browser-auth";

describe("R-1548 — too many wrong passwords on the login page", () => {
  it("signInWithPassword turns the code into the Hinglish message with status 429", async () => {
    const { error } = await browserAuth().signInWithPassword({ email: "owner@shop.in", password: "x" });
    expect(error?.code).toBe(TOO_MANY_ATTEMPTS_CODE);
    expect(error?.status).toBe(429);
    expect(error?.message).toBe(TOO_MANY_ATTEMPTS_MESSAGE);
    expect(TOO_MANY_ATTEMPTS_MESSAGE).toContain("Bahut baar galat password — 15 minute baad koshish karo");
  });

  it("the login page shows that message with a Forgot password link", () => {
    const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/code === TOO_MANY_ATTEMPTS_CODE/);
    expect(page).toMatch(/\{TOO_MANY_ATTEMPTS_MESSAGE\}/);
    expect(page).toMatch(/href="\/forgot-password"[^>]*>Forgot password</);
  });
});
