/**
 * R-2176 (GP-10c, G-PERSONAL) — a PERSONAL user's Help → Report a problem becomes a ticket on the
 * seller company's support desk (their free support plan), never a `feedback` row.
 *
 * The rules themselves (personal check, link, cap, insert) live in the SQL function
 * personal_file_support_ticket and are proven AS THE SIGNED-IN USER in
 * supabase/tests/r2176_personal_file_support_ticket.test.sql (the first version mocked the DB
 * here and missed that the service-role client cannot read users under the gateway). This file
 * checks what the TypeScript adds: the payload sent to the function, and each refusal mapped to
 * an honest "NOT sent" message.
 */
import { describe, it, expect } from "vitest";
import {
  ticketFieldsFromReport,
  filePersonalSupportTicket,
  resultFromRpcError,
  PERSONAL_REPORT_MAX_CHARS,
  type PersonalReportRpc,
} from "./personal-report";

const REPORT = { type: "bug" as const, severity: "medium" as const, text: "Bank balance shows 0\n\nI added a statement and the tile still says 0.", pagePath: "/vault/personal/banking" };

function fakeRpc(answer: { data: unknown; error: { message: string } | null } | Error) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: PersonalReportRpc = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { db, calls };
}

describe("ticketFieldsFromReport", () => {
  it("first line is the subject; kind and severity map onto the desk's own vocabulary", () => {
    expect(ticketFieldsFromReport(REPORT)).toEqual({ subject: "Bank balance shows 0", category: "tech", priority: "normal" });
    expect(ticketFieldsFromReport({ ...REPORT, type: "feature", severity: "low" })).toMatchObject({ category: "feature", priority: "low" });
    expect(ticketFieldsFromReport({ ...REPORT, type: "ui_improvement", severity: "high" })).toMatchObject({ category: "tech", priority: "high" });
    expect(ticketFieldsFromReport({ ...REPORT, severity: "critical" })).toMatchObject({ priority: "urgent" });
  });
  it("a long first line is cut to 120 characters", () => {
    const s = ticketFieldsFromReport({ ...REPORT, text: "x".repeat(300) }).subject;
    expect(s.length).toBe(120);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("filePersonalSupportTicket (R-2176)", () => {
  it("calls personal_file_support_ticket with subject/body/category/priority only — no user, tenant or customer", async () => {
    const { db, calls } = fakeRpc({ data: "TKT-ABC-1F", error: null });
    const r = await filePersonalSupportTicket(db, REPORT);
    expect(r).toEqual({ ok: true, ticketId: "TKT-ABC-1F" });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("personal_file_support_ticket");
    expect(Object.keys(calls[0].args).sort()).toEqual(["p_body", "p_category", "p_priority", "p_subject"]);
    expect(calls[0].args).toMatchObject({ p_subject: "Bank balance shows 0", p_category: "tech", p_priority: "normal" });
    expect(String(calls[0].args.p_body)).toContain("I added a statement");
    expect(String(calls[0].args.p_body)).toMatch(/Page: \/vault\/personal\/banking$/);
  });

  it("a very long report is cut so the body (with the page line) stays within the SQL limit", async () => {
    const { db, calls } = fakeRpc({ data: "T", error: null });
    await filePersonalSupportTicket(db, { ...REPORT, text: "y".repeat(PERSONAL_REPORT_MAX_CHARS) });
    expect(String(calls[0].args.p_body).length).toBeLessThanOrEqual(PERSONAL_REPORT_MAX_CHARS);
    expect(String(calls[0].args.p_body)).toMatch(/Page: /);
  });

  it("empty text → 400, no call", async () => {
    const { db, calls } = fakeRpc({ data: "T", error: null });
    expect(await filePersonalSupportTicket(db, { ...REPORT, text: "   " })).toMatchObject({ ok: false, code: "EMPTY", status: 400 });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["R2176_NOT_LINKED: no support desk is linked to this login yet.", 409, "NOT_LINKED"],
    ["R2176_NOT_PERSONAL: this is for personal accounts.", 403, "NOT_PERSONAL"],
    ["R2176_TOO_MANY: 10 reports in the last hour.", 429, "TOO_MANY"],
    ["R2176_BAD_INPUT: the report is empty", 400, "BAD_INPUT"],
    ["R2176_NOT_SIGNED_IN: sign in again", 401, "NOT_SIGNED_IN"],
    ["permission denied for function personal_file_support_ticket", 500, "FAILED"],
  ])("SQL error %s → %i %s", async (message, status, code) => {
    const { db } = fakeRpc({ data: null, error: { message } });
    const r = await filePersonalSupportTicket(db, REPORT);
    expect(r).toMatchObject({ ok: false, status, code });
  });

  it("every refusal a person can hit says the report was NOT sent; raw DB text never shows", () => {
    for (const m of ["R2176_NOT_LINKED", "R2176_TOO_MANY", "R2176_BAD_INPUT", "boom: relation x"]) {
      const r = resultFromRpcError(m);
      expect(r.error).toMatch(/NOT sent/);
      expect(r.error).not.toMatch(/boom|relation/);
    }
  });

  it("no ticket number back, or the call throws → 500 FAILED, NOT sent", async () => {
    expect(await filePersonalSupportTicket(fakeRpc({ data: null, error: null }).db, REPORT)).toMatchObject({ ok: false, code: "FAILED" });
    expect(await filePersonalSupportTicket(fakeRpc(new Error("network")).db, REPORT)).toMatchObject({ ok: false, code: "FAILED" });
  });
});
