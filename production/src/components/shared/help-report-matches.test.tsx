// @vitest-environment jsdom
/**
 * R-1417 — Report a problem shows the company's own open reports that match what is being typed.
 *  • matches appear after a short pause in typing, up to 5, titles only;
 *  • the read is pinned to the caller's tenant and to still-open reports (no body column read);
 *  • a failed read says so, and says the report can still be submitted.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const h = vi.hoisted(() => ({ calls: [] as [string, ...unknown[]][], rows: [] as unknown[], error: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const builder: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["from", "select", "eq", "in", "order", "limit"]) {
      builder[m] = (...a: unknown[]) => { h.calls.push([m, ...a]); return builder; };
    }
    (builder as { then?: unknown }).then = (ok: (v: unknown) => void) => ok({ data: h.rows, error: h.error });
    return builder;
  },
}));

import { HelpReportMatches, fetchOpenReportTitles, MATCH_DEBOUNCE_MS } from "./help-report-matches";
import type { ReportTitle } from "@/lib/feedback/similar-reports";

const rows: ReportTitle[] = [
  { id: "a", title: "Invoice PDF download fails", status: "open", created_at: "2026-10-10T00:00:00Z" },
  { id: "b", title: "Quote shows wrong GST", status: "open", created_at: "2026-10-11T00:00:00Z" },
  { id: "c", title: "PDF download blank for invoice", status: "agent_queued", created_at: "2026-10-12T00:00:00Z" },
];

beforeEach(() => { vi.useFakeTimers(); h.calls = []; h.rows = []; h.error = null; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function flush() { await act(async () => { await Promise.resolve(); }); }

describe("fetchOpenReportTitles", () => {
  it("reads only this tenant's open / being-fixed reports, and only the title columns", async () => {
    h.rows = rows;
    const out = await fetchOpenReportTitles("t1");
    expect(out).toEqual(rows);
    expect(h.calls).toContainEqual(["from", "feedback"]);
    expect(h.calls).toContainEqual(["select", "id, title, status, created_at"]);
    expect(h.calls).toContainEqual(["eq", "tenant_id", "t1"]);
    expect(h.calls).toContainEqual(["in", "status", ["open", "agent_queued"]]);
  });

  it("throws when the read fails, so the tab can say so", async () => {
    h.error = { message: "permission denied" };
    await expect(fetchOpenReportTitles("t1")).rejects.toBeTruthy();
  });
});

describe("HelpReportMatches", () => {
  it("shows matching reports after the typing pause — titles and status, nothing else", async () => {
    const load = vi.fn(async () => rows);
    const { rerender } = render(<HelpReportMatches text="" tenantId="t1" load={load} />);
    await flush();
    expect(screen.queryByTestId("help-report-matches")).toBeNull();

    rerender(<HelpReportMatches text="invoice pdf download is broken" tenantId="t1" load={load} />);
    expect(screen.queryByTestId("help-report-matches")).toBeNull(); // still typing
    await act(async () => { vi.advanceTimersByTime(MATCH_DEBOUNCE_MS); });

    const box = screen.getByTestId("help-report-matches");
    expect(box.textContent).toContain("2 similar reports already filed by your company");
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("PDF download blank for invoice");
    expect(items[0]).toContain("Being fixed");
    expect(items[1]).toContain("Invoice PDF download fails");
    expect(items[1]).toContain("Open");
    expect(box.textContent).not.toContain("Quote shows wrong GST");
    expect(load).toHaveBeenCalledWith("t1");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads nothing without a tenant", async () => {
    const load = vi.fn(async () => rows);
    render(<HelpReportMatches text="invoice pdf download" tenantId={null} load={load} />);
    await act(async () => { vi.advanceTimersByTime(MATCH_DEBOUNCE_MS); });
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByTestId("help-report-matches")).toBeNull();
  });

  it("a failed read is said plainly, with what to do next", async () => {
    const load = vi.fn(async () => { throw new Error("network"); });
    render(<HelpReportMatches text="invoice pdf download" tenantId="t1" load={load} />);
    await flush();
    await act(async () => { vi.advanceTimersByTime(MATCH_DEBOUNCE_MS); });
    expect(screen.getByRole("status").textContent).toMatch(/Could not check for similar reports.*still submit/);
  });
});
