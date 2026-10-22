import { describe, it, expect } from "vitest";
import { rowStageOptions, isStageLocked, type Stage } from "./stage-options";

const ALL: Stage[] = ["new", "contact", "quote", "demo", "trial", "won", "lost"];

describe("the invariant — a row never misstates its own stage", () => {
  it("includes the lead's current stage for EVERY stage", () => {
    /* This is the whole point. When it was false, a `won` deal rendered inside a select
       of new/contact/lost, and the browser showed the first option: both won deals read
       "New" beside ₹4,39,994 already collected. */
    for (const s of ALL) expect(rowStageOptions(s)).toContain(s);
  });

  it("never returns an empty list", () => {
    for (const s of ALL) expect(rowStageOptions(s).length).toBeGreaterThan(0);
  });

  it("does not depend on which page is showing — there is no page argument", () => {
    expect(rowStageOptions.length).toBe(1);
  });
});

describe("the quote-first gate survives", () => {
  it("does not let a new or contacted lead jump to demo, trial or quote", () => {
    /* Sending a quote is the one gate out of the inbox. A dropdown that skipped it would
       create deals sitting at `trial` with no quotation behind them — nothing to invoice
       against and nothing the customer ever agreed to. */
    for (const s of ["new", "contact"] as Stage[]) {
      const opts = rowStageOptions(s);
      expect(opts).not.toContain("demo");
      expect(opts).not.toContain("trial");
      expect(opts).not.toContain("quote");
      expect(opts).not.toContain("won");
    }
  });

  it("offers the full close-out path once a quote is out", () => {
    expect(rowStageOptions("quote")).toEqual(["quote", "demo", "trial", "won", "lost"]);
    expect(rowStageOptions("trial")).toContain("won");
  });

  it("lets every open stage be marked lost", () => {
    for (const s of ["new", "contact", "quote", "demo", "trial"] as Stage[]) {
      expect(rowStageOptions(s)).toContain("lost");
    }
  });
});

describe("won goes only to lost (R-1762)", () => {
  it("offers Lost and nothing that walks a won deal back into the pipeline", () => {
    /* The customer backed out after accepting → Lost, with a reason; the money check (client
       and database) refuses it when a payment, invoice or subscription exists. A mistaken
       accept goes back to Quote from the quote's Reopen, not from here. */
    expect(rowStageOptions("won")).toEqual(["won", "lost"]);
    for (const s of ["new", "contact", "quote", "demo", "trial"] as Stage[]) {
      expect(rowStageOptions("won")).not.toContain(s);
    }
  });

  it("leaves every stage editable", () => {
    for (const s of ALL) expect(isStageLocked(s)).toBe(false);
  });
});

describe("lost can come back", () => {
  it("offers a way back to new and contact", () => {
    /* Without one, the only route is a duplicate record — which splits the history of a
       single relationship across two rows. */
    expect(rowStageOptions("lost")).toContain("new");
    expect(rowStageOptions("lost")).toContain("contact");
  });

  it("does not let a lost deal be revived straight into won", () => {
    expect(rowStageOptions("lost")).not.toContain("won");
  });
});
