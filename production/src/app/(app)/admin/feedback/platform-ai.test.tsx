// @vitest-environment jsdom
/**
 * R-366 — platform rows on /admin/feedback → All workspaces show the R-356 AI labels and a
 * "Send to AI" button only on open, never-dispatched rows.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn(), warning: vi.fn() } }));

import { PlatformAiStatus, SendToAiButton, SendAllOpenButton } from "./platform-ai";

type R = { id: string; status: string; dispatched_at: string | null; resolution_note: string | null; resolved_at: string | null };
const row = (over: Partial<R>) =>
  ({ id: "11111111-1111-4111-8111-111111111111", status: "open", dispatched_at: null, resolution_note: null, resolved_at: null, ...over }) as never;

const wrap = (ui: React.ReactElement) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

afterEach(() => { cleanup(); vi.restoreAllMocks(); toastSuccess.mockReset(); });

describe("PlatformAiStatus — R-356 labels on platform rows", () => {
  it("queued row: 'AI worker has it'", () => {
    wrap(<PlatformAiStatus row={row({ status: "agent_queued", dispatched_at: new Date().toISOString() })} />);
    expect(screen.getByTestId("platform-ai-queued").textContent).toContain("AI worker has it");
  });

  it("fixed row with an AI note: 'Fixed by AI · R-354' + commit", () => {
    wrap(<PlatformAiStatus row={row({ status: "fixed", resolution_note: "AI ne theek kiya: R-354 (279cb0d2) - date fixed." })} />);
    const t = screen.getByTestId("platform-ai-fixed").textContent ?? "";
    expect(t).toContain("Fixed by AI");
    expect(t).toContain("R-354");
    expect(t).toContain("279cb0d2");
  });

  it("open row: no label", () => {
    const { container } = wrap(<PlatformAiStatus row={row({})} />);
    expect(container.textContent).toBe("");
  });
});

describe("Send to AI buttons", () => {
  it("only an open, never-dispatched row has Send to AI", () => {
    wrap(<>
      <SendToAiButton row={row({})} />
      <SendToAiButton row={row({ id: "b", status: "agent_queued", dispatched_at: "2026-10-07T05:00:00Z" })} />
      <SendToAiButton row={row({ id: "c", status: "fixed" })} />
    </>);
    expect(screen.getAllByRole("button", { name: /Send to AI/ })).toHaveLength(1);
  });

  it("posts only the id to the dispatch route and toasts the result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ queued: ["11111111-1111-4111-8111-111111111111"], skipped: [] }), { status: 200 }),
    );
    wrap(<SendToAiButton row={row({})} />);
    fireEvent.click(screen.getByRole("button", { name: /Send to AI/ }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/feedback/platform/dispatch");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ id: "11111111-1111-4111-8111-111111111111" });
    expect(toastSuccess.mock.calls[0][0]).toBe("1 report sent to the AI worker");
  });

  it("Send all open counts only open rows and hides when none", () => {
    const { rerender } = wrap(<SendAllOpenButton rows={[row({}), row({ id: "b", status: "agent_queued", dispatched_at: "x" })]} />);
    expect(screen.getByRole("button").textContent).toContain("Send all open to AI (1)");
    rerender(<QueryClientProvider client={new QueryClient()}><SendAllOpenButton rows={[row({ status: "fixed" })]} /></QueryClientProvider>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
