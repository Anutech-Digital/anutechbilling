// @vitest-environment jsdom
/** R-352 — AI Help shows "Last tested … 5 ✓ 1 ✗" for the page, and nothing when there is no run / no table. */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

const db = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as null | { code: string } },
  pages: [] as unknown[],
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/deals", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { if (c === "page_path") db.pages.push(v); return q; },
        order: () => q,
        limit: () => q,
        maybeSingle: () => Promise.resolve(db.result),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "t1", fullName: "Test", userId: "u1", authEmail: null } }) }));
vi.mock("@/lib/queries/feedback", () => ({ useSubmitFeedback: () => ({ mutateAsync: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { AiHelp, AiHelpButton, LastTestedNote } from "./ai-help";

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => {
  /* close the shared panel state so the next test starts closed */
  const btn = screen.queryByRole("button", { name: /^Help —/ });
  if (btn?.getAttribute("aria-pressed") === "true") fireEvent.click(btn);
  cleanup();
  db.result = { data: null, error: null };
  db.pages = [];
});

const RESULTS = [
  ...Array.from({ length: 5 }, (_, i) => ({ test: `ok ${i}`, result: "pass" })),
  { test: "Back button keeps the filter", result: "fail", note: "filter lost" },
];

async function openPanel() {
  render(<><AiHelpButton /><AiHelp /></>);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Help —/ })); });
  await act(async () => { await Promise.resolve(); });
}

describe("LastTestedNote", () => {
  it("shows date, counts and the failed test", () => {
    render(<LastTestedNote run={{ pagePath: "/deals", runAt: "2026-10-07T05:22:00Z", buildSha: "51629ab", runBy: "AI browser test", results: RESULTS as never }} />);
    const el = screen.getByTestId("ai-help-last-tested");
    expect(el.textContent).toContain("Last tested 7 Oct, 10:52 · 5 ✓ 1 ✗");
    expect(el.textContent).toContain("✗ Back button keeps the filter");
  });
  it("renders nothing without a run", () => {
    const { container } = render(<LastTestedNote run={null} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("AI Help panel — Last tested line", () => {
  it("reads this page's last run and shows it at the top", async () => {
    db.result = { data: { page_path: "/deals", run_at: "2026-10-07T05:22:00Z", build_sha: "51629ab", run_by: "AI browser test", results: RESULTS }, error: null };
    await openPanel();
    expect(db.pages).toContain("/deals");
    expect((await screen.findByTestId("ai-help-last-tested")).textContent).toContain("5 ✓ 1 ✗");
  });
  it("table missing (migration not applied) → panel works, no line", async () => {
    db.result = { data: null, error: { code: "42P01" } };
    await openPanel();
    expect(screen.getByRole("button", { name: /Check this page/i })).toBeTruthy();
    expect(screen.queryByTestId("ai-help-last-tested")).toBeNull();
  });
});

describe("AI Help panel — follow-up chips (R-353)", () => {
  const fetchMock = vi.fn();
  /* The panel wraps window.fetch once (trail of failed calls) and keeps the first fetch it
     saw in __aiHelpFetch — so the mock goes there, not on globalThis. */
  const w = window as Window & { __aiHelpFetch?: typeof fetch };
  let saved: typeof fetch | undefined;
  beforeEach(() => { fetchMock.mockReset(); saved = w.__aiHelpFetch; w.__aiHelpFetch = fetchMock as unknown as typeof fetch; });
  afterEach(() => { w.__aiHelpFetch = saved; });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const answer = (body: unknown) => Promise.resolve(json(body));

  async function askTyped(q: string) {
    const box = screen.getByLabelText("Your question");
    fireEvent.change(box, { target: { value: q } });
    await act(async () => { fireEvent.submit(box.closest("form")!); });
    await act(async () => { await Promise.resolve(); });
  }

  it("shows chips under the last answer; a tap sends that question; the new answer replaces them", async () => {
    fetchMock
      .mockReturnValueOnce(answer({ reply: "Inme se kaunsa pehle?", ai: true, followUps: ["Quick Add bar pehle", "Bulk reschedule pehle"] }))
      .mockReturnValueOnce(answer({ reply: "Theek hai, Quick Add bar.", ai: true, followUps: [] }));
    await openPanel();
    await askTyped("Tasks page better kaise ho?");
    const chips = await screen.findByTestId("ai-help-followups");
    expect(chips.textContent).toContain("Quick Add bar pehle");
    const chip = screen.getByRole("button", { name: "Ask: Quick Add bar pehle" });
    expect(chip.className).toContain("min-h-10");

    await act(async () => { fireEvent.click(chip); });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string) as { messages: { role: string; text: string }[]; mode: string };
    expect(body.mode).toBe("chat");
    expect(body.messages[body.messages.length - 1]).toEqual({ role: "user", text: "Quick Add bar pehle" });
    expect(await screen.findByText("Theek hai, Quick Add bar.")).toBeTruthy();
    expect(screen.queryByTestId("ai-help-followups")).toBeNull();
  });

  it("hides old chips as soon as a new message is sent, and an answer without followUps shows none", async () => {
    let release: (v: Response) => void = () => {};
    fetchMock
      .mockReturnValueOnce(answer({ reply: "Pehla jawab", ai: true, followUps: ["Agla sawal?"] }))
      .mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    await openPanel();
    await askTyped("pehla");
    expect(await screen.findByTestId("ai-help-followups")).toBeTruthy();
    await askTyped("doosra");
    expect(screen.queryByTestId("ai-help-followups")).toBeNull();
    await act(async () => { release(json({ reply: "Doosra jawab", ai: true })); });
    expect(await screen.findByText("Doosra jawab")).toBeTruthy();
    expect(screen.queryByTestId("ai-help-followups")).toBeNull();
  });
});
