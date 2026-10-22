/**
 * R-1762 (Pardeep, 22 Oct 2026): "deal galti won ho gayi to isko thik karne ka koi raasta hai"
 * + "won se lost karne ki bhi baat hai". The owner's three examples:
 *   1. Quote accepted by mistake, no money → Reopen → quote Sent, deal back to Quote, Won count −1.
 *   2. Customer backed out after accepting, no money → Mark lost → reason → deal Lost, quote Rejected.
 *   3. Won deal with a payment → Mark lost is refused: "<name> has a payment or invoice — …".
 * The database enforces the same rule (supabase/tests/r1762_won_deal_undo.test.sql); these are
 * the client halves.
 */
import { describe, it, expect } from "vitest";
import { checkBoardMove, checkWonExit, wonMoneyRefusal } from "@/lib/leads/deal-rules";
import { rowStageOptions, isStageLocked } from "@/lib/leads/stage-options";
import { dashboardPipeline, stageTotalsFromRows } from "@/lib/deals/pipeline-summary";
import { readFileSync } from "node:fs";

const wonDeal = { stage: "won" as const, company: "Backout Co", value: 10_000, expected_close_date: "2026-10-30" };

describe("example 2 — a Won deal can be marked Lost", () => {
  it("the board and the stepper allow Won → Lost (the reason prompt and money check follow)", () => {
    expect(checkBoardMove(wonDeal, "lost").ok).toBe(true);
  });
  it("the row's stage options offer Lost on a Won deal, nothing else", () => {
    expect(rowStageOptions("won")).toEqual(["won", "lost"]);
    expect(isStageLocked("won")).toBe(false);
  });
  it("other moves out of Won are still refused and say what to do instead", () => {
    const v = checkBoardMove(wonDeal, "trial");
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.title).toBe("Backout Co is already won");
      expect(v.description).toContain("Reopen");
      expect(v.description).toContain("Mark lost");
    }
  });
});

describe("example 3 — money behind the Won deal refuses the move", () => {
  it("names the deal and says refund or credit-note it first", () => {
    expect(wonMoneyRefusal("Paid Co")).toBe(
      "Paid Co has a payment or invoice — refund or credit-note it first, then mark it lost.",
    );
    expect(wonMoneyRefusal("  ")).toBe(
      "This deal has a payment or invoice — refund or credit-note it first, then mark it lost.",
    );
  });
  it("checkWonExit refuses with money, allows without, and ignores deals that are not Won", () => {
    const refused = checkWonExit({ stage: "won", company: "Paid Co" }, "lost", true);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.description).toBe(wonMoneyRefusal("Paid Co"));
    expect(checkWonExit({ stage: "won", company: "Backout Co" }, "lost", false).ok).toBe(true);
    expect(checkWonExit({ stage: "quote", company: "X" }, "lost", true).ok).toBe(true);
    expect(checkWonExit({ stage: "won", company: "X" }, "won", true).ok).toBe(true);
  });
  it("the stage door asks the database before the lost-reason prompt", () => {
    const src = readFileSync("src/lib/leads/use-change-stage.ts", "utf8");
    expect(src).toMatch(/rpc\("lead_has_money"/);
    expect(src.indexOf('rpc("lead_has_money"')).toBeLessThan(src.indexOf("askLossReason(lead.company)"));
  });
});

describe("example 1 — Reopen takes the deal out of the Won count", () => {
  it("dashboard Won count drops when one Won deal goes back to Quote and one to Lost", () => {
    const before = dashboardPipeline(stageTotalsFromRows([
      { stage: "won", value: 10_000 }, { stage: "won", value: 10_000 }, { stage: "won", value: 5_000 },
    ]));
    const after = dashboardPipeline(stageTotalsFromRows([
      { stage: "quote", value: 10_000 }, { stage: "lost", value: 10_000 }, { stage: "won", value: 5_000 },
    ]));
    expect(before.won).toEqual({ count: 3, value: 25_000 });
    expect(after.won).toEqual({ count: 1, value: 5_000 });
    expect(after.open.count).toBe(1);
  });
  it("the quote page's Reopen confirm says the deal moves back too", () => {
    const src = readFileSync("src/app/(app)/quotes/[id]/page.tsx", "utf8");
    expect(src).toContain("It moves back to Sent and the deal back to Quote. The customer record stays.");
  });
});

describe("Mark lost is offered on a Won deal everywhere the deal is opened", () => {
  it.each([
    "src/components/features/leads/lead-detail-footer.tsx",
    "src/components/features/deals/deal-detail-view.tsx",
  ])("%s no longer hides Mark lost on Won", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(/lead\.stage !== "lost" && lead\.stage !== "won" && \(\s*<Button[^]*?Mark lost/);
  });
  it("the board's own Won lock lets a drop on Lost through", () => {
    const src = readFileSync("src/components/features/leads/leads-kanban-board.tsx", "utf8");
    expect(src).toMatch(/lead\.stage === "won" && toStage !== "won" && toStage !== "lost"/);
  });
});
