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
  const btn = screen.queryByRole("button", { name: /AI Help/ });
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
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /AI Help/ })); });
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
