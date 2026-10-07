// @vitest-environment jsdom
/**
 * R-397 — the "⚡ Urgent" toggle and strip on /admin/feedback: hidden before the migration,
 * drawn on open/queued/claimed rows, posts {id, urgent} to /api/feedback/urgent, and an
 * urgent queued row reads "⚡ Urgent · AI worker has it · R-xxx" (own and platform rows).
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError, warning: vi.fn() } }));

import { UrgentToggle, UrgentStrip } from "./urgent-toggle";
import { PlatformAiStatus } from "./platform-ai";

const ID = "11111111-1111-4111-8111-111111111111";
const wrap = (ui: React.ReactElement) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

afterEach(() => { cleanup(); vi.restoreAllMocks(); toastSuccess.mockReset(); toastError.mockReset(); });

describe("UrgentToggle — R-397", () => {
  it("is hidden before the migration (row has no urgent_at key)", () => {
    const { container } = wrap(<UrgentToggle row={{ id: ID, status: "open" }} />);
    expect(container.textContent).toBe("");
  });

  it("is drawn on open, queued and claimed rows; not on a closed, non-urgent row", () => {
    wrap(<>
      <UrgentToggle row={{ id: "a", status: "open", urgent_at: null }} />
      <UrgentToggle row={{ id: "b", status: "agent_queued", urgent_at: null }} />
      <UrgentToggle row={{ id: "c", status: "agent_queued", urgent_at: null, agent_claimed_at: "2026-10-07T06:00:00Z" }} />
      <UrgentToggle row={{ id: "d", status: "fixed", urgent_at: null }} />
    </>);
    expect(screen.getByTestId("urgent-toggle-a")).toBeTruthy();
    expect(screen.getByTestId("urgent-toggle-b")).toBeTruthy();
    expect(screen.getByTestId("urgent-toggle-c")).toBeTruthy();
    expect(screen.queryByTestId("urgent-toggle-d")).toBeNull();
  });

  it("posts urgent:true on an open row and says it went to the AI", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, urgent: true, queued: true }), { status: 200 }),
    );
    wrap(<UrgentToggle row={{ id: ID, status: "open", urgent_at: null }} />);
    const btn = screen.getByTestId(`urgent-toggle-${ID}`);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/feedback/urgent");
    expect(JSON.parse(String(init.body))).toEqual({ id: ID, urgent: true });
    expect(String(toastSuccess.mock.calls[0][0])).toMatch(/sent to the AI worker/);
  });

  it("an urgent row is pressed in and posts urgent:false to take it back", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, urgent: false, queued: false }), { status: 200 }),
    );
    wrap(<UrgentToggle row={{ id: ID, status: "agent_queued", urgent_at: "2026-10-07T06:00:00Z" }} />);
    const btn = screen.getByTestId(`urgent-toggle-${ID}`);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ id: ID, urgent: false });
  });

  it("a 403 shows the server's reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Only the workspace owner or a manager can mark a report urgent." }), { status: 403 }),
    );
    wrap(<UrgentToggle row={{ id: ID, status: "agent_queued", urgent_at: null }} />);
    fireEvent.click(screen.getByTestId(`urgent-toggle-${ID}`));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toContain("owner or a manager");
  });
});

describe("Urgent strip — R-397 label", () => {
  it("own row: ⚡ Urgent · AI worker has it · R-xxx", () => {
    wrap(<UrgentStrip card="R-412" urgentAt={null} />);
    expect(screen.getByTestId("ai-urgent-strip").textContent).toBe("⚡ Urgent · AI worker has it · R-412");
  });

  it("platform row: an urgent queued row shows the urgent strip with the claimed card", () => {
    wrap(<PlatformAiStatus row={{
      id: ID, status: "agent_queued", dispatched_at: "2026-10-07T05:00:00Z", resolution_note: null, resolved_at: null,
      urgent_at: "2026-10-07T06:00:00Z", agent_card: "R-401",
    } as never} />);
    expect(screen.getByTestId("ai-urgent-strip").textContent).toContain("⚡ Urgent · AI worker has it · R-401");
    expect(screen.queryByTestId("platform-ai-queued")).toBeNull();
  });

  it("platform row: not urgent → the plain R-356 queued label", () => {
    wrap(<PlatformAiStatus row={{
      id: ID, status: "agent_queued", dispatched_at: "2026-10-07T05:00:00Z", resolution_note: null, resolved_at: null, urgent_at: null,
    } as never} />);
    expect(screen.getByTestId("platform-ai-queued")).toBeTruthy();
    expect(screen.queryByTestId("ai-urgent-strip")).toBeNull();
  });
});
