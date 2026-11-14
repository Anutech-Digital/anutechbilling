/**
 * R-2760 (R-2739c): the status filter and bulk Send renewal on the row's ONE stage (R-2738 model).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renewalStage, type StageInput } from "@/lib/renewals/stage";
import { NO_FILTERS, NO_EMAIL_REASON, STAGE_FILTER_LABEL, bulkStageTargets, filterQueue, type QueueRow } from "./queue";

const TODAY = "2026-11-14";
const sub = { status: "active", renewal_date: "2026-12-01", term_months: 12, billing_cycle: "yearly", start_date: "2025-12-01", auto_renew: true, renewal_quote_id: null as string | null };
const stageOf = (i: Partial<StageInput> = {}) => renewalStage({ sub, todayIst: TODAY, ...i });

const row = (id: string, stageKey: QueueRow["stageKey"]): QueueRow => ({
  id, daysUntil: 10, amount: 100, plan: "P", vendor: "google", statusKey: "due", stageKey, atRisk: false, customer: id,
});

describe("R-2760 status filter = the stage", () => {
  it("every stage has the chip's word, incl. quote-closed", () => {
    expect(STAGE_FILTER_LABEL["quote-closed"]).toBe("Quote closed");
    expect(STAGE_FILTER_LABEL.due).toBe("Not sent");
    expect(STAGE_FILTER_LABEL.sent).toBe("Quote sent");
    expect(Object.keys(STAGE_FILTER_LABEL).sort()).toEqual(["draft", "due", "ending", "invoiced", "part-due", "quote-closed", "renewed", "sent", "stopped"]);
  });
  it("filters by stage; a row still loading matches no stage", () => {
    const rows = [row("a", "sent"), row("b", "due"), row("c", null)];
    expect(filterQueue(rows, { ...NO_FILTERS, status: "sent" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterQueue(rows, NO_FILTERS).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("R-2760 bulk Send renewal on the stage", () => {
  const email = (x: { email?: string | null }) => x.email;
  it("sends only 'not sent' whole-term rows with an email; names every other row's reason", () => {
    const rows = [
      { id: "due", stage: stageOf(), email: "a@x.test" },
      { id: "no-email", stage: stageOf(), email: null as string | null },
      { id: "sent", stage: stageOf({ doc: { kind: "renewal", quoteId: "Q-1", status: "sent" } }), email: "b@x.test" },
      { id: "loading", stage: null, email: "c@x.test" },
      { id: "split", stage: renewalStage({ sub: { ...sub, billing_cycle: "monthly" }, todayIst: TODAY }), email: "d@x.test" },
    ];
    const r = bulkStageTargets(rows, email);
    expect(r.send.map((x) => x.id)).toEqual(["due"]);
    const why = Object.fromEntries(r.skipped.map((s) => [s.row.id, s.reason]));
    expect(why["no-email"]).toBe(NO_EMAIL_REASON);
    expect(why.sent).toMatch(/^Renewal quote sent/);
    expect(why.loading).toMatch(/still loading/);
    expect(why.split).toMatch(/billed in parts/);
  });
  it("contacts not read yet → skipped as loading, never as 'no email'", () => {
    const r = bulkStageTargets([{ stage: stageOf(), email: undefined as string | undefined }], email);
    expect(r.skipped[0].reason).toMatch(/still loading/);
  });
  it("the page wires it: stage filter options + bulkStageTargets(selectedRows, emailOf)", () => {
    const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
    expect(page).toContain("bulkStageTargets(selectedRows, emailOf, docsState.failed)");
    expect(page).toContain("STAGE_FILTER_ORDER.filter((k) => statusCount(k) > 0 || filters.status === k)");
    expect(page).not.toContain("bulkQuoteTargets(");
  });
});
