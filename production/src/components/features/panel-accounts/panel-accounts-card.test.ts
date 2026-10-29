/**
 * R-2103: the staff card's rules — who may act, and the go-live backfill question built from
 * its dry-run count (nothing is queued before the person has seen the number).
 */
import { describe, it, expect } from "vitest";
import { backfillQuestion, panelAccountRights } from "./panel-accounts-card";

describe("panel accounts card (R-2103)", () => {
  it("owner and manager may retry and backfill; support and sales only look", () => {
    expect(panelAccountRights("owner").canAct).toBe(true);
    expect(panelAccountRights("manager").canAct).toBe(true);
    expect(panelAccountRights("support").canAct).toBe(false);
    expect(panelAccountRights(null).canAct).toBe(false);
  });

  it("the backfill question names the count from the dry run", () => {
    const q = backfillQuestion({ dry_run: true, with_email: 40, without_email: 3, queued: 0 });
    expect(q.title).toBe("Give 43 existing customers a panel login?");
    expect(q.body).toContain("40 will get");
    expect(q.body).toContain("3 have no email");
    expect(backfillQuestion({ dry_run: true, with_email: 1, without_email: 0, queued: 0 }).title).toBe("Give 1 existing customer a panel login?");
  });
});
