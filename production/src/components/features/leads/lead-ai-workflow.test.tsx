// @vitest-environment jsdom
//
// R-2042 — AI Lead Workflow D, the owner's path in the lead drawer header: press
// "Run AI Lead Workflow" → it POSTs /api/leads/[id]/ai-workflow (R-2039) → while the run is open
// the chips follow GET (Fetching data → AI qualified → Draft ready …) → polling stops when the run
// has finished → at Draft ready a link opens the Email tab draft (R-2040). A refused run shows the
// route's reason AND its next step (§24). The list/board badge shows the lead's ai_status.
// fetch is mocked — no AI is called, no email leaves.
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LeadAiWorkflow, AI_POLL_MS, aiChipStates } from "./lead-ai-workflow";
import { LeadAiStatusBadge, AI_STATUS_LABEL } from "./lead-ai-status";

const RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
type Run = Record<string, unknown>;
const run = (step: string, extra: Run = {}): Run => ({
  id: RUN, step, qualify_result: null, pitch: null, draft_subject: null, error: null, next_step: null,
  started_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-02T10:00:05Z", finished_at: null, ...extra,
});

/* What GET returns, call by call (the last one repeats). */
let getQueue: Array<{ status: number; json: unknown }> = [];
let postReply: { status: number; json: unknown } | null = null;
let releasePost: (() => void) | null = null;
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === "POST") {
    await new Promise<void>((r) => { releasePost = r; });
    return new Response(JSON.stringify(postReply!.json), { status: postReply!.status });
  }
  const next = getQueue.length > 1 ? getQueue.shift()! : getQueue[0];
  return new Response(JSON.stringify(next.json), { status: next.status });
});
const gets = () => fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === "GET").length;
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

function renderIt(onOpenDraft = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><LeadAiWorkflow leadId="L1" onOpenDraft={onOpenDraft} /></QueryClientProvider>);
  return { onOpenDraft };
}
const chip = (label: RegExp) => screen.getByRole("listitem", { name: label });

beforeEach(() => {
  getQueue = [{ status: 200, json: { run: null } }];
  postReply = null;
  releasePost = null;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("R-2042 Run AI Lead Workflow button", () => {
  it("is a non-primary button that POSTs the lead's ai-workflow route and is disabled while it runs", async () => {
    renderIt();
    const btn = await screen.findByRole("button", { name: "Run AI Lead Workflow" });
    expect(btn.className).not.toMatch(/bg-amber/); // one primary per view (R-2265) — the drawer has its own
    postReply = { status: 200, json: { run: run("draft_ready", { qualify_result: { verdict: "qualified", reasons: [] }, pitch: "Hi", finished_at: "2026-11-02T10:01:00Z" }) } };
    fireEvent.click(btn);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe("/api/leads/L1/ai-workflow");
    expect((screen.getByRole("button", { name: /Run AI Lead Workflow|Running/ }) as HTMLButtonElement).disabled).toBe(true);
    getQueue = [{ status: 200, json: postReply.json }]; // the server's latest run is now the finished one
    await act(async () => { releasePost!(); });
    await waitFor(() => expect(chip(/Draft ready/).getAttribute("data-state")).toBe("done"));
    expect((screen.getByRole("button", { name: "Run AI Lead Workflow" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("chips advance as GET returns new steps, then polling stops when the run has finished", async () => {
    getQueue = [
      { status: 200, json: { run: run("fetching") } },
      { status: 200, json: { run: run("qualified", { qualify_result: { verdict: "qualified", reasons: ["Uses Google Workspace"] } }) } },
      { status: 200, json: { run: run("draft_ready", { qualify_result: { verdict: "qualified", reasons: [] }, pitch: "Hi", finished_at: "2026-11-02T10:01:00Z" }) } },
    ];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderIt();
    await waitFor(() => expect(chip(/Fetching data/).getAttribute("data-state")).toBe("current"));
    expect((screen.getByRole("button", { name: /Running/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(chip(/AI qualified/).getAttribute("data-state")).toBe("todo");

    await act(async () => { await vi.advanceTimersByTimeAsync(AI_POLL_MS); });
    await waitFor(() => expect(chip(/AI qualified/).getAttribute("data-state")).toBe("done"));
    expect(chip(/Fetching data/).getAttribute("data-state")).toBe("done");
    expect(chip(/Draft ready/).getAttribute("data-state")).toBe("current");

    await act(async () => { await vi.advanceTimersByTimeAsync(AI_POLL_MS); });
    await waitFor(() => expect(chip(/Draft ready/).getAttribute("data-state")).toBe("done"));
    expect(chip(/^Sent/).getAttribute("data-state")).toBe("todo");
    const after = gets();
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_POLL_MS * 5); });
    expect(gets()).toBe(after); // finished → no more polling
  });

  it("after Draft ready, links to the draft in the Email tab", async () => {
    getQueue = [{ status: 200, json: { run: run("draft_ready", { qualify_result: { verdict: "qualified", reasons: [] }, pitch: "Hi", finished_at: "2026-11-02T10:01:00Z" }) } }];
    const { onOpenDraft } = renderIt();
    fireEvent.click(await screen.findByRole("button", { name: /Open the draft/ }));
    expect(onOpenDraft).toHaveBeenCalledTimes(1);
  });

  it("Not qualified shows the AI's reasons and no later chips", async () => {
    getQueue = [{ status: 200, json: { run: run("unqualified", { qualify_result: { verdict: "unqualified", reasons: ["Only 2 mailboxes", "No business domain"] }, next_step: "No email draft was written.", finished_at: "2026-11-02T10:01:00Z" }) } }];
    renderIt();
    await waitFor(() => expect(chip(/Not qualified/).getAttribute("data-state")).toBe("failed"));
    expect(screen.getByText("Only 2 mailboxes")).toBeTruthy();
    expect(screen.getByText("No business domain")).toBeTruthy();
    expect(screen.queryByRole("listitem", { name: /Draft ready/ })).toBeNull();
  });

  it("a refused run shows the route's error and next step", async () => {
    renderIt();
    postReply = { status: 503, json: { error: "AI is not set up for this workspace.", detail: "Ask the owner to add the AI key in Settings." } };
    fireEvent.click(await screen.findByRole("button", { name: "Run AI Lead Workflow" }));
    await waitFor(() => expect(releasePost).toBeTypeOf("function"));
    await act(async () => { releasePost!(); });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("AI is not set up for this workspace.");
    expect(alert.textContent).toContain("Ask the owner to add the AI key in Settings.");
  });

  it("a run that failed earlier shows its error + next step after a reload", async () => {
    getQueue = [{ status: 200, json: { run: run("failed", { qualify_result: { verdict: "qualified", reasons: [] }, error: "The AI service did not answer.", next_step: "Try again in a few minutes.", finished_at: "2026-11-02T10:01:00Z" }) } }];
    renderIt();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The AI service did not answer.");
    expect(alert.textContent).toContain("Try again in a few minutes.");
    expect(chip(/Draft ready/).getAttribute("data-state")).toBe("failed");
  });

  it("is hidden for a role the route refuses (403)", async () => {
    getQueue = [{ status: 403, json: { error: "Your role cannot open this page." } }];
    renderIt();
    await waitFor(() => expect(gets()).toBeGreaterThan(0));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Run AI Lead Workflow" })).toBeNull();
  });
});

describe("aiChipStates", () => {
  it("sent / call steps mark every chip up to them done", () => {
    const s = aiChipStates(run("call_scheduled", { finished_at: "x" }) as never, false);
    expect(s.map((c) => c.state)).toEqual(["done", "done", "done", "done", "done", "todo"]);
    expect(aiChipStates(run("call_done", { finished_at: "x" }) as never, false).every((c) => c.state === "done")).toBe(true);
  });
  it("a press before the first GET shows Fetching data as current", () => {
    expect(aiChipStates(null, true)[0].state).toBe("current");
  });
});

describe("R-2042 ai_status badge on list/board cards", () => {
  it.each(Object.entries(AI_STATUS_LABEL))("%s → %s", (status, label) => {
    render(<LeadAiStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeTruthy();
    cleanup();
  });
  it("renders nothing without a status (or an unknown one)", () => {
    const { container } = render(<><LeadAiStatusBadge status={null} /><LeadAiStatusBadge status="weird" /></>);
    expect(container.innerHTML).toBe("");
  });
  it("labels match the card", () => {
    expect(AI_STATUS_LABEL.qualified).toBe("AI: Qualified");
    expect(AI_STATUS_LABEL.draft_ready).toBe("AI: Draft ready");
    expect(AI_STATUS_LABEL.sent).toBe("AI: Sent");
  });
});
