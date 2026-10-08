// @vitest-environment jsdom
/**
 * R-383 — Report Bug + AI Help are ONE Help button. The "Report a problem" tab:
 *  • Ctrl+Shift+B opens Help straight on that tab (and closes it when pressed again);
 *  • with AI off (no key / error / no network) the plain form still submits — never blocked;
 *  • the submit payload has exactly the old Report Bug dialog's keys (same insert + triage path);
 *  • the recorded last steps go with the report, and an AI draft (when AI works) is editable.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  fetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/invoices", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "t1", fullName: "Test User", userId: "u1", authEmail: "t@x.in", role: "employee" } }) }));
vi.mock("@/lib/queries/feedback", () => ({ useSubmitFeedback: () => ({ mutateAsync: h.mutateAsync, isPending: false }) }));
vi.mock("@/lib/ai/page-test-runs", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/page-test-runs")>()), loadLastPageTestRun: async () => null }));
vi.mock("sonner", () => ({ toast: h.toast }));

import * as React from "react";
import { AiHelp, AiHelpButton } from "./ai-help";
import { GlobalBugReporter } from "./global-bug-reporter";
import { reportTextWithContext, draftToText } from "./help-report-tab";

const NO_KEY_REPLY = { reply: "Is company ke liye AI (Gemini) key nahi lagi hai", bugDraft: null, checklist: [], followUps: [], ai: false, reason: "no_key" };
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  /* AI Help wraps window.fetch once and remembers the original — give it this test's mock. */
  delete (window as Window & { __aiHelpFetch?: typeof fetch }).__aiHelpFetch;
  h.fetch.mockReset();
  window.fetch = h.fetch as unknown as typeof fetch;
  h.mutateAsync.mockReset();
  h.mutateAsync.mockResolvedValue({ id: "f1", uploaded: 0, failedUploads: [], triaged: true });
  Object.values(h.toast).forEach((f) => f.mockReset());
});
afterEach(() => {
  const btn = screen.queryByRole("button", { name: /^Help —/ });
  if (btn?.getAttribute("aria-pressed") === "true") fireEvent.click(btn);
  cleanup();
});

function mount() {
  render(<><GlobalBugReporter /><AiHelpButton /><AiHelp /></>);
}
const ctrlShiftB = () => act(() => { fireEvent.keyDown(window, { key: "B", ctrlKey: true, shiftKey: true }); });
const box = () => screen.getByLabelText("What went wrong?") as HTMLTextAreaElement;

describe("R-383 — Ctrl+Shift+B opens Help on the Report tab", () => {
  it("opens the one Help panel with 'Report a problem' selected, and closes it on a second press", () => {
    mount();
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
    ctrlShiftB();
    expect(screen.getByRole("dialog", { name: "Help" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Report a problem/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Ask" }).getAttribute("aria-selected")).toBe("false");
    expect(box()).toBeTruthy();
    ctrlShiftB();
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
  });

  it("the Ask tab is today's AI Help, unchanged (Check this page + the chat box)", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Help —/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Ask" }));
    expect(screen.getByRole("button", { name: /Check this page/ })).toBeTruthy();
    expect(screen.getByLabelText("Your question")).toBeTruthy();
    expect(screen.queryByLabelText("What went wrong?")).toBeNull();
  });
});

describe("R-383 — reporting never waits on AI", () => {
  it("AI off (no key): the draft button says so, the words stay, and Submit files the plain report", async () => {
    h.fetch.mockImplementation(() => json(NO_KEY_REPLY));
    mount();
    ctrlShiftB();
    fireEvent.change(box(), { target: { value: "Invoice total shows NaN" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Write it up with AI/ })); });
    await waitFor(() => expect(h.toast.warning).toHaveBeenCalled());
    expect(box().value).toBe("Invoice total shows NaN");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit report" })); });
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
    const payload = h.mutateAsync.mock.calls[0][0];
    expect(payload.text.startsWith("Invoice total shows NaN")).toBe(true);
    expect(payload.reportedType).toBe("bug");
    expect(payload.reportedSeverity).toBe("medium");
    expect(h.toast.success).toHaveBeenCalledWith("Report submitted — thank you.", expect.anything());
    /* filed → the panel closes */
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
  });

  it("AI unreachable (network error): still submits", async () => {
    h.fetch.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    mount();
    ctrlShiftB();
    fireEvent.change(box(), { target: { value: "Save button does nothing" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Write it up with AI/ })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit report" })); });
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("a failed insert keeps the text and says it was NOT saved", async () => {
    h.mutateAsync.mockRejectedValue(new Error("network down"));
    mount();
    ctrlShiftB();
    fireEvent.change(box(), { target: { value: "Keep me" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit report" })); });
    expect(h.toast.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ description: expect.stringMatching(/NOT saved/) }));
    expect(box().value).toBe("Keep me");
  });

  it("an empty box is not sent", async () => {
    mount();
    ctrlShiftB();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit report" })); });
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledWith("Report box is empty", expect.anything());
  });

  it("AI on: the draft fills the box for editing and sets kind/severity; nothing is filed until Submit", async () => {
    h.fetch.mockImplementation(() => json({ reply: "ok", ai: true, bugDraft: { title: "GST shows NaN on invoice", type: "bug", severity: "high", actual: "Total reads ₹NaN", expected: "Total in rupees", steps: ["Open invoice", "Look at total"], chatSummary: "" } }));
    mount();
    ctrlShiftB();
    fireEvent.change(box(), { target: { value: "total NaN" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Write it up with AI/ })); });
    await waitFor(() => expect(box().value.startsWith("GST shows NaN on invoice")).toBe(true));
    expect(h.mutateAsync).not.toHaveBeenCalled();
    const body = JSON.parse(String(h.fetch.mock.calls[0][1]?.body));
    expect(body.mode).toBe("chat");
    expect(Array.isArray(body.trail)).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit report" })); });
    expect(h.mutateAsync.mock.calls[0][0].reportedSeverity).toBe("high");
  });
});

describe("R-383 — same payload as the old Report Bug form", () => {
  it("sends exactly FeedbackDialog's keys (no filedVia — it is a form report) with the page and reporter", async () => {
    mount();
    ctrlShiftB();
    fireEvent.change(box(), { target: { value: "Button overlaps text" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit report" })); });
    const payload = h.mutateAsync.mock.calls[0][0] as Record<string, unknown>;

    const src = readFileSync(join(process.cwd(), "src/components/shared/feedback-dialog.tsx"), "utf8");
    const block = src.slice(src.indexOf("submit.mutateAsync({"), src.indexOf("});", src.indexOf("submit.mutateAsync({")));
    const formKeys = Array.from(block.matchAll(/^\s+(\w+):/gm)).map((m) => m[1]).sort();
    expect(formKeys.length).toBeGreaterThanOrEqual(9);
    expect(Object.keys(payload).sort()).toEqual(formKeys);

    expect(payload).toMatchObject({
      tenantId: "t1", reportedType: "bug", reportedSeverity: "medium", pagePath: "/invoices",
      reporterId: "u1", reporterName: "Test User", reporterEmail: "t@x.in", screenshots: [],
    });
    /* the recorder's last steps go with it — the page open was recorded on mount */
    expect(String(payload.text)).toMatch(/What the app recorded \(last steps\):\n.*OPENED: \/invoices/);
  });
});

describe("helpers", () => {
  it("reportTextWithContext: words first, then the recorded steps; nothing recorded → words only", () => {
    expect(reportTextWithContext("  hi  ", [])).toBe("hi");
    const t = reportTextWithContext("Broken", [{ kind: "api_fail", at: 1000, text: "POST /api/x → 500", path: "/deals" }], 3000);
    expect(t.split("\n")[0]).toBe("Broken");
    expect(t).toContain("API FAILED: POST /api/x → 500 (on /deals)");
  });
  it("draftToText puts the title on the first line", () => {
    const t = draftToText({ title: "T", type: "bug", severity: "low", actual: "A", expected: "", steps: ["s1"], chatSummary: "" });
    expect(t).toBe("T\n\nA\n\nSteps:\n1. s1");
  });
});
