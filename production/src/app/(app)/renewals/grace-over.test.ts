import { describe, it, expect } from "vitest";
import {
  canDecideGrace, graceOverRows, parseExtraDays, stopServiceConfirm, stoppedToast, extendedToast,
  type GraceOverRow,
} from "./grace-over";

const row = (over: Partial<GraceOverRow> = {}): GraceOverRow => ({
  id: "s1", customer_id: "c1", customer_name: "Late Co", plan: "Business Starter", vendor: "google",
  status: "active", renewal_state: "grace_period", renewal_date: "2026-10-01", grace_until: null,
  grace_task_for: "2026-10-01", ...over,
});

describe("R-1621 Grace over list", () => {
  it("lists only active rows whose task is for the CURRENT term", () => {
    const rows = [
      row(),
      row({ id: "paid", renewal_date: "2027-10-01", renewal_state: "renewed" }),         // paid: date rolled
      row({ id: "old", renewal_date: "2027-10-01", renewal_state: "pending" }),          // task was last term's
      row({ id: "stopped", status: "paused", renewal_state: "suspended" }),
      row({ id: "none", grace_task_for: null }),
    ];
    expect(graceOverRows(rows).map((r) => r.id)).toEqual(["s1"]);
  });

  it("only owner and manager decide", () => {
    expect(canDecideGrace("owner")).toBe(true);
    expect(canDecideGrace("manager")).toBe(true);
    for (const r of ["billing", "accountant", "sales", null, undefined]) expect(canDecideGrace(r)).toBe(false);
  });

  it("+ days box takes 1..30 whole days, like the server", () => {
    expect(parseExtraDays("7")).toBe(7);
    expect(parseExtraDays(" 30 ")).toBe(30);
    for (const bad of ["0", "31", "", "2.5", "-3", "abc"]) expect(parseExtraDays(bad)).toBeNull();
  });

  it("the stop confirm and toast give the vendor's manual step (no vendor API)", () => {
    const c = stopServiceConfirm(row());
    expect(c.title).toBe("Stop service for Late Co?");
    expect(c.body).toContain("1 Oct 2026");
    expect(c.body).toContain("Google Admin");
    expect(stoppedToast(row({ vendor: "microsoft" })).description).toContain("Partner Center");
    expect(stoppedToast(row({ vendor: "domain" })).description).toContain("lapses by itself");
  });

  it("the extend toast names the new grace end", () => {
    expect(extendedToast(row(), "2026-10-20", 5)).toContain("grace now ends 20 Oct 2026");
  });
});
