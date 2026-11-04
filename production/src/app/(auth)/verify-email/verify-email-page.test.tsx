// @vitest-environment jsdom
/* R-1926 (G-ONBOARD OB-5) — owner's path on the page: open "Confirm my email" from the mail →
   the page goes straight to the setup wizard, signed in (no "Sign in" button, no password).
   When the server did not sign them in (join request, no session), the old "Sign in" stays. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("token=" + "t".repeat(43)) }));
vi.mock("@/components/features/auth/resend-verification", () => ({ ResendVerification: () => null }));

import VerifyEmailPage from "./page";
import { VERIFY_LANDINGS } from "@/lib/auth/verify-landing";

const go = vi.fn();
let reply: Record<string, unknown> = {};

beforeEach(() => {
  go.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => reply })));
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, replace: go } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-1926 /verify-email", () => {
  it("signed in by the link → straight to /setup?welcome=1, no Sign in button", async () => {
    reply = { ok: true, email: "asha@rao-traders.in", joinRequestedTo: null, signedIn: true, next: "/setup?welcome=1" };
    render(<VerifyEmailPage />);
    await waitFor(() => expect(go).toHaveBeenCalledWith("/setup?welcome=1"));
    expect(screen.getByText(/Opening your setup/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("R-2119: a personal signup signed in by the link → straight to /money, no Sign in button", async () => {
    reply = { ok: true, email: "ravi@gmail.test", joinRequestedTo: null, signedIn: true, next: "/money" };
    render(<VerifyEmailPage />);
    await waitFor(() => expect(go).toHaveBeenCalledWith("/money"));
    expect(screen.queryByText(/Opening your setup/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("R-2119: every landing the server can give is followed (same list as verify-landing.ts)", async () => {
    for (const next of VERIFY_LANDINGS) {
      go.mockReset(); cleanup();
      reply = { ok: true, signedIn: true, next };
      render(<VerifyEmailPage />);
      await waitFor(() => expect(go).toHaveBeenCalledWith(next));
    }
  });

  it("R-2119: a same-site path that is not a landing (e.g. /money/../admin, /settings) is never followed", async () => {
    for (const next of ["/settings", "/money/../admin", "//evil.example", "/money?x=1"]) {
      go.mockReset(); cleanup();
      reply = { ok: true, email: "a@b.test", signedIn: true, next };
      render(<VerifyEmailPage />);
      await screen.findByRole("link", { name: "Sign in" });
      expect(go).not.toHaveBeenCalled();
    }
  });

  it("a destination outside the allowed two is never followed", async () => {
    reply = { ok: true, email: "asha@rao-traders.in", signedIn: true, next: "https://evil.example/x" };
    render(<VerifyEmailPage />);
    await screen.findByRole("link", { name: "Sign in" });
    expect(go).not.toHaveBeenCalled();
  });

  it("not signed in → the old 'Email confirmed · Sign in' screen", async () => {
    reply = { ok: true, email: "asha@rao-traders.in", joinRequestedTo: null, signedIn: false };
    render(<VerifyEmailPage />);
    await screen.findByRole("link", { name: "Sign in" });
    expect(go).not.toHaveBeenCalled();
  });
});
