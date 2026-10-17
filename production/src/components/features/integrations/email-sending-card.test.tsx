// @vitest-environment jsdom
/**
 * R-1425 — Email sending card when Google is not ready.
 * Pinned: Gmail with no Google connection shows "Connect Google first" + Connect (no PATCH,
 * no error toast); a server 409 lands in the same calm notice; a server with no Google
 * client says "not available on this server yet" with no Connect button; a non-owner is
 * told to ask the owner; a connected sender still switches to Gmail as before.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import EmailSendingCard from "./email-sending-card";

type Settings = Record<string, unknown>;
const base = (over: Partial<Settings> = {}, gmail: Partial<Settings> = {}): Settings => ({
  provider: "resend",
  fromAddress: null,
  fromName: null,
  hasResendKey: true,
  hasEnvResendKey: false,
  googleConfigured: true,
  gmail: { senderId: "U1", isDesignated: false, email: null, canSend: false, ...gmail },
  senderCandidates: [],
  canChooseSender: true,
  canSendNow: true,
  ...over,
});

let settings: Settings;
let patchResponse: { status: number; body: unknown };
let patches: unknown[];

beforeEach(() => {
  settings = base();
  patchResponse = { status: 200, body: { ok: true } };
  patches = [];
  Object.values(toastMock).forEach((f) => f.mockReset());
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(patchResponse.body), { status: patchResponse.status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(settings), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderCard = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <EmailSendingCard />
    </QueryClientProvider>,
  );

const gmailButton = async () => screen.findByRole("button", { name: /^Gmail/ });

describe("EmailSendingCard — Google not ready (R-1425)", () => {
  it("Gmail with no Google connection → 'Connect Google first' + Connect, no PATCH, no error toast", async () => {
    renderCard();
    fireEvent.click(await gmailButton());
    const notice = await screen.findByRole("status", { name: /gmail sender/i });
    expect(notice.textContent).toMatch(/connect google first/i);
    expect(notice.querySelector("a[href='/api/integrations/google-gmail/connect']")).not.toBeNull();
    expect(patches).toHaveLength(0);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("a 409 from the server lands in the same calm notice, not an error toast", async () => {
    settings = base({}, { email: "a@b.in", canSend: true });
    patchResponse = { status: 409, body: { code: "google_not_connected", error: "That account has not connected Google yet." } };
    renderCard();
    fireEvent.click(await gmailButton());
    const notice = await screen.findByRole("status", { name: /gmail sender/i });
    expect(notice.textContent).toMatch(/connect google first/i);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("server has no Google client → 'not available on this server yet', no Connect anywhere", async () => {
    settings = base({ googleConfigured: false });
    renderCard();
    await gmailButton();
    expect(screen.getAllByText(/not available on this server yet/i).length).toBeGreaterThan(0);
    expect(document.querySelector("a[href='/api/integrations/google-gmail/connect']")).toBeNull();
    fireEvent.click(await gmailButton());
    expect(patches).toHaveLength(0);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("non-owner → provider buttons disabled with 'ask the workspace owner'", async () => {
    settings = base({ canChooseSender: false });
    renderCard();
    const btn = await gmailButton();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/ask the workspace owner/i)).toBeTruthy();
  });

  it("connected sender → Gmail switches as before (PATCH sent, success toast)", async () => {
    settings = base({}, { email: "a@b.in", canSend: true });
    renderCard();
    fireEvent.click(await gmailButton());
    await waitFor(() => expect(patches).toEqual([{ provider: "gmail" }]));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    expect(screen.queryByRole("status", { name: /gmail sender/i })).toBeNull();
  });
});
