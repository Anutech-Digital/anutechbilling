// @vitest-environment jsdom
/* R-1897 — Co-pilot Step 3 screen. Owner examples (Pardeep, 25 Oct):
     1. "Diwali Workspace" plan, Google + Meta, lead_gen. A headline typed to 31 characters →
        the counter shows 31/30 in red; back to 30 → normal.
     2. "Rewrite this line" on headline 4 → only headline 4 changes.
     3. An edit autosaves by itself a moment later (with the version it loaded).
     4. Google set full but Meta empty → "Mark ready" is blocked and says what Meta still needs. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  sets: [] as unknown[],
  saveSet: vi.fn(),
  rewriteLine: vi.fn(),
  writeCopy: vi.fn(),
  markReady: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("./use-copy", () => ({
  ApiError: class extends Error { constructor(m: string, readonly status: number, readonly body: Record<string, unknown>) { super(m); } },
  copyKey: (id: string) => ["copilot-copy", id],
  useCopySets: () => ({ isLoading: false, error: null, data: { status: "draft", sets: h.sets }, dataUpdatedAt: 1, refetch: vi.fn() }),
  saveSet: h.saveSet,
  rewriteLine: h.rewriteLine,
  writeCopy: h.writeCopy,
  markReady: h.markReady,
  listVersions: vi.fn(async () => ({ versions: [] })),
}));

import { LineRow, StepThree, type StepThreePlan } from "./step-three";
import { fieldSpec } from "@/lib/marketing/copilot/channel-specs";

const PLAN: StepThreePlan = {
  id: "6f1c2a52-6b8e-4b7a-9a59-0f5e8f3f0a11", objective: "lead_gen", platforms: ["google-ads", "meta-ads"],
  lookalike: false, language: "en", product: "Google Workspace", status: "draft",
};
const row = (field: string, text: string, position: number) => ({
  platform: "google-ads", audience: "generic", format: "search", field, text, position, locked: false, pinned: null, ai_generated: true,
});
const googleSet = {
  platform: "google-ads", audience: "generic", format: "search", version: 3,
  rows: [
    ...Array.from({ length: 15 }, (_, i) => row("headline", `Workspace headline ${i + 1}`, i)),
    ...Array.from({ length: 4 }, (_, i) => row("description", `Google Workspace set up by our own Delhi team, option ${i + 1}.`, i)),
  ],
};

function renderStep() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><StepThree plan={PLAN} /></QueryClientProvider>);
}
const headline = (n: number) => screen.getByLabelText(`Headline ${n}`, { selector: "input" }) as HTMLInputElement;
const googlePanel = () => document.getElementById("copilot-panel-google-ads") as HTMLElement;

beforeEach(() => {
  h.sets = [googleSet];
  h.saveSet.mockReset().mockResolvedValue({ version: 4, status: "draft" });
  h.rewriteLine.mockReset();
  h.writeCopy.mockReset();
  h.markReady.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("live counter", () => {
  it("31/30 in red on a Google headline; 30/30 normal", () => {
    const spec = fieldSpec("google-ads", "search", "headline")!;
    const line = { key: "k1", text: "a".repeat(31), locked: false, pinned: null, ai: false };
    const noop = () => {};
    const { rerender } = render(<ol><LineRow platform="google-ads" field={spec} line={line} n={1} busy={false}
      onText={noop} onKeep={noop} onPin={noop} onDelete={noop} onRewrite={noop} /></ol>);
    const counter = screen.getByTestId("counter");
    expect(counter.textContent).toBe("31/30");
    expect(counter.getAttribute("data-tone")).toBe("over");
    expect(counter.className).toMatch(/text-rose-ink/);
    expect(screen.getByLabelText("Headline 1").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/1 over the 30-character limit/)).toBeTruthy();

    rerender(<ol><LineRow platform="google-ads" field={spec} line={{ ...line, text: "a".repeat(30) }} n={1} busy={false}
      onText={noop} onKeep={noop} onPin={noop} onDelete={noop} onRewrite={noop} /></ol>);
    expect(screen.getByTestId("counter").textContent).toBe("30/30");
    expect(screen.getByTestId("counter").getAttribute("data-tone")).toBe("ok");
    expect(screen.getByLabelText("Headline 1").getAttribute("aria-invalid")).toBeNull();
  });

  it("typing in the Step 3 editor updates the counter as you type", () => {
    renderStep();
    const input = within(googlePanel()).getAllByLabelText("Headline 1")[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: "x".repeat(31) } });
    const counter = document.getElementById(`${input.id}-count`)!;
    expect(counter.textContent).toBe("31/30");
    expect(counter.getAttribute("data-tone")).toBe("over");
  });
});

describe("Rewrite this line", () => {
  it("changes only headline 4", async () => {
    h.rewriteLine.mockResolvedValueOnce({ text: "Email your team will love", length: 25, limit: 30 });
    renderStep();
    const before = Array.from({ length: 15 }, (_, i) => headline(i + 1).value);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Rewrite headline 4" })); });
    expect(h.rewriteLine).toHaveBeenCalledWith(expect.objectContaining({
      platform: "google-ads", field: "headline", current: "Workspace headline 4", audience: "generic",
    }));
    expect(h.rewriteLine.mock.calls[0][0].others).toHaveLength(14);
    const after = Array.from({ length: 15 }, (_, i) => headline(i + 1).value);
    expect(after[3]).toBe("Email your team will love");
    after.forEach((v, i) => { if (i !== 3) expect(v).toBe(before[i]); });
  });
});

describe("autosave", () => {
  it("an edit saves by itself a moment later, with the loaded version", async () => {
    vi.useFakeTimers();
    renderStep();
    fireEvent.change(headline(2), { target: { value: "Diwali email offer" } });
    expect(h.saveSet).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(h.saveSet).toHaveBeenCalledTimes(1);
    const [planId, body] = h.saveSet.mock.calls[0];
    expect(planId).toBe(PLAN.id);
    expect(body).toMatchObject({ platform: "google-ads", audience: "generic", format: "search", expectedVersion: 3 });
    expect(body.lines.find((l: { field: string; position: number }) => l.field === "headline" && l.position === 1).text).toBe("Diwali email offer");
    expect(screen.getByText(/Saved · version 4/)).toBeTruthy();
  });
});

describe("Mark ready", () => {
  it("blocked while Meta has no copy, and says what Meta still needs", () => {
    renderStep();
    const btn = screen.getByRole("button", { name: "Mark ready" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/Meta \(Facebook \/ Instagram\) · Main audience: 1 more primary text, 1 more headline, a call-to-action button/)).toBeTruthy();
  });

  it("allowed once Meta has a full set too", () => {
    h.sets = [googleSet, {
      platform: "meta-ads", audience: "generic", format: "feed_image", version: 1,
      rows: [
        { ...row("primary_text", "This Diwali, move your office email to Google Workspace.", 0), platform: "meta-ads", format: "feed_image" },
        { ...row("headline", "Workspace for Diwali", 0), platform: "meta-ads", format: "feed_image" },
        { ...row("cta", "GET_QUOTE", 0), platform: "meta-ads", format: "feed_image" },
      ],
    }];
    renderStep();
    expect((screen.getByRole("button", { name: "Mark ready" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
