// @vitest-environment jsdom
/**
 * R-2396 (G-PERSONAL, GP-06) — owner 3 Nov: "individual kaise register karega".
 *
 *   flag OFF (staging/live today) → /signup is the business form exactly as before, no choice;
 *   flag ON  (localhost)          → first "Business account" / "Personal account (free)";
 *   personal form                 → no company name / GSTIN; Create is disabled until the
 *                                   consent tick; posts kind 'personal' + consent true + marketing;
 *                                   then the same "Check your inbox" as business;
 *   an invite link                → always the business form (invites join a company).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true, createClient: () => ({}) }));
vi.mock("@/components/shared/turnstile", () => ({ useTurnstile: () => ({ headers: {}, widget: null, reset: () => {} }) }));
vi.mock("@/components/features/auth/google-button", () => ({ GoogleAuthButton: () => <button type="button">Sign up with Google</button> }));
vi.mock("@/components/features/auth/resend-verification", () => ({ ResendVerification: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import SignupPage from "./page";
import { PersonalSignupFlagProvider } from "./signup-flag-context";

const fetchMock = vi.fn();

function setSearch(search: string) {
  window.history.replaceState(null, "", `/signup${search}`);
}

function renderSignup(enabled: boolean) {
  return render(
    <PersonalSignupFlagProvider enabled={enabled}>
      <SignupPage />
    </PersonalSignupFlagProvider>,
  );
}

beforeEach(() => {
  setSearch("");
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, status: "created", needsVerification: true, verificationSent: true }) });
  vi.stubGlobal("fetch", fetchMock);
  /* Radix Checkbox measures itself; jsdom has no ResizeObserver. */
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-2396 /signup — business or personal", () => {
  it("flag off: the business form as before, no choice and no personal option", () => {
    renderSignup(false);
    expect(screen.getByRole("heading", { name: "Create your ResellerOS workspace" })).toBeTruthy();
    expect(screen.getByLabelText(/Company name/)).toBeTruthy();
    expect(screen.queryByText("Personal account (free)")).toBeNull();
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });

  it("flag on: the first question is Business account / Personal account (free)", () => {
    renderSignup(true);
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Business account/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Personal account \(free\)/ })).toBeTruthy();
    expect(screen.queryByLabelText(/Company name/)).toBeNull();
  });

  it("Business account opens the business form, with a way back", () => {
    renderSignup(true);
    fireEvent.click(screen.getByRole("button", { name: /Business account/ }));
    expect(screen.getByLabelText(/Company name/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeTruthy();
  });

  it("an invite link skips the question and opens the business form", async () => {
    setSearch("?invite=abc123");
    renderSignup(true);
    await waitFor(() => expect(screen.getByLabelText(/Company name/)).toBeTruthy());
  });

  it("?type=personal opens the personal form directly", async () => {
    setSearch("?type=personal");
    renderSignup(true);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Create your free personal account" })).toBeTruthy());
  });
});

describe("R-2396 personal form — consent is required", () => {
  async function openPersonal() {
    renderSignup(true);
    fireEvent.click(screen.getByRole("button", { name: /Personal account \(free\)/ }));
    await screen.findByRole("heading", { name: "Create your free personal account" });
  }
  function fill() {
    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: "Ravi Kumar" } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "ravi@gmail.test" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "Strong#Pass2026" } });
  }

  it("asks only name, email, password — no company name, no GSTIN", async () => {
    await openPersonal();
    expect(screen.getByLabelText(/Full name/)).toBeTruthy();
    expect(screen.queryByLabelText(/Company name/)).toBeNull();
    expect(screen.queryByLabelText(/GSTIN/)).toBeNull();
    expect(screen.getByRole("link", { name: "Terms" }).getAttribute("href")).toBe("/terms");
    expect(screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe("/privacy");
  });

  it("Create free account stays disabled until the consent box is ticked", async () => {
    await openPersonal();
    fill();
    const create = screen.getByRole("button", { name: "Create free account" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /financial records/ }));
    expect(create.disabled).toBe(false);
  });

  it("posts kind personal with consent (marketing as ticked), then shows Check your inbox", async () => {
    await openPersonal();
    fill();
    fireEvent.click(screen.getByRole("checkbox", { name: /financial records/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /tips and offers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create free account" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/signup");
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "personal", email: "ravi@gmail.test", password: "Strong#Pass2026", fullName: "Ravi Kumar", consent: true, marketing: true,
    });
    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeTruthy();
    expect(screen.getByText("ravi@gmail.test")).toBeTruthy();
  });
});
