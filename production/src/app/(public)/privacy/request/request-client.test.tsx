// @vitest-environment jsdom
/**
 * R-2013 (DPDP, part A): the logged-out "Your data" form — fill it, get the code by email,
 * enter it, see "Request received" with the answer-by date. fetch is mocked (no real mail).
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/shared/turnstile", () => ({ useTurnstile: () => ({ headers: {}, widget: null, reset: () => {} }) }));

import { PrivacyRequestClient, formatDue } from "./request-client";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("/privacy/request", () => {
  it("form → code → received, answer by the due date", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const json = url.endsWith("/verify") ? { ok: true, dueBy: "2026-12-02", kind: "withdraw_consent" } : { ok: true, requestId: "11111111-2222-4333-8444-555555555555", minutes: 15 };
      return new Response(JSON.stringify(json), { status: 200 });
    }));
    render(<PrivacyRequestClient />);
    for (const label of ["See my data", "Correct my data", "Delete my data", "Withdraw my consent", "Nominate someone"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: "Asha Verma" } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "Asha@Example.in" } });
    fireEvent.click(screen.getByLabelText(/Withdraw my consent/));
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));

    await screen.findByText("Enter the code");
    expect(calls[0]).toMatchObject({ url: "/api/public/privacy-request", body: { fullName: "Asha Verma", email: "Asha@Example.in", kind: "withdraw_consent" } });
    expect(screen.getByText("asha@example.in")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Code/), { target: { value: "12 34 56" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm my request" }));
    await waitFor(() => expect(screen.getByTestId("privacy-request-done")).toBeTruthy());
    expect(calls[1]).toMatchObject({ url: "/api/public/privacy-request/verify", body: { code: "123456" } });
    expect(screen.getByTestId("privacy-request-done").textContent).toMatch(/answer by 2 December 2026/);
    expect(screen.getByTestId("privacy-request-done").textContent).toMatch(/already stopped/);
  });

  it("shows the server's words when something is wrong", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Too many requests from here." }), { status: 429 })));
    render(<PrivacyRequestClient />);
    fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: "Asha" } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "a@example.in" } });
    fireEvent.click(screen.getByLabelText(/See my data/));
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Too many requests/);
  });

  it("formatDue", () => {
    expect(formatDue(null)).toBe("within 30 days");
  });
});
