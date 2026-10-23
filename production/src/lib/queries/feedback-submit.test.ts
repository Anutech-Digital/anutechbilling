/**
 * R-1501 — Pawan (team member) pressed Submit on Help → Report a problem (one screenshot attached)
 * and got "You don't have access to this. Your report was NOT saved." The database refused the
 * `feedback` row with 42501 because that request went out without his sign-in (see
 * lib/auth/browser-auth.test.ts). The row is the only fatal step; when it is refused for "no
 * access", a fresh token is fetched and the SAME row (same id) is tried once more.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  upload: vi.fn(),
  forget: vi.fn(),
  tables: [] as string[],
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => { h.tables.push(table); return { insert: (row: unknown) => h.insert(table, row) }; },
    storage: { from: () => ({ upload: h.upload }) },
  }),
}));
vi.mock("@/lib/auth/browser-auth", () => ({ forgetBrowserSession: h.forget }));

import { submitFeedback, type SubmitFeedbackInput } from "./feedback";

const RLS = { code: "42501", message: 'new row violates row-level security policy for table "feedback"' };
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const input = (over: Partial<SubmitFeedbackInput> = {}): SubmitFeedbackInput => ({
  tenantId: "11111111-1111-4111-8111-111111111111",
  reportedType: "bug",
  reportedSeverity: "medium",
  text: "Full cart for hosting is not working\nCannot test buying",
  pagePath: "/settings",
  reporterId: "22222222-2222-4222-8222-222222222222",
  reporterName: "Pawan Kumar",
  reporterEmail: "pawan@example.in",
  screenshots: [{ name: "help_report_screen_1.jpg", dataUrl: PNG }],
  ...over,
});

beforeEach(() => {
  h.insert.mockReset();
  h.upload.mockReset();
  h.forget.mockReset();
  h.tables.length = 0;
  h.upload.mockResolvedValue({ data: { path: "x" }, error: null });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
});

describe("R-1501 — a 'no access' refusal of the report row", () => {
  it("first insert refused with 42501 → fresh token, same row retried once, report and screenshot saved", async () => {
    h.insert.mockImplementation(async (table: string) => {
      if (table !== "feedback") return { error: null };
      return h.insert.mock.calls.filter((c) => c[0] === "feedback").length === 1 ? { error: RLS } : { error: null };
    });
    const res = await submitFeedback(input());
    const rows = h.insert.mock.calls.filter((c) => c[0] === "feedback").map((c) => c[1] as { id: string });
    expect(rows).toHaveLength(2);
    expect(rows[1].id).toBe(rows[0].id); // same id: can never become two reports
    expect(h.forget).toHaveBeenCalledTimes(1);
    expect(res.uploaded).toBe(1);
    expect(res.failedUploads).toEqual([]);
    expect(h.upload.mock.calls[0][0]).toMatch(new RegExp(`^${input().tenantId}/feedback/${rows[0].id}/`));
  });

  it("refused again → throws 'Report not saved' with the database's reason; no screenshot is uploaded", async () => {
    h.insert.mockResolvedValue({ error: RLS });
    await expect(submitFeedback(input())).rejects.toThrow(/Report not saved: new row violates row-level security.*\(42501\)/);
    expect(h.insert.mock.calls.filter((c) => c[0] === "feedback")).toHaveLength(2);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("any other error is not retried (a real problem must show at once)", async () => {
    h.insert.mockResolvedValue({ error: { code: "23514", message: "violates check constraint" } });
    await expect(submitFeedback(input())).rejects.toThrow(/Report not saved/);
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.forget).not.toHaveBeenCalled();
  });

  it("a refused screenshot never loses the report: saved, and the screenshot is named as not attached", async () => {
    h.insert.mockResolvedValue({ error: null });
    h.upload.mockResolvedValue({ data: null, error: { message: "new row violates row-level security policy", statusCode: "403" } });
    const res = await submitFeedback(input());
    expect(res.failedUploads).toEqual(["help_report_screen_1.jpg"]);
    expect(res.uploaded).toBe(0);
  });
});
