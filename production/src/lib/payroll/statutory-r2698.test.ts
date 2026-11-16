/**
 * R-2698 — what the employee form says about statutory switches:
 *  • which already-booked salary months carry PF / ESI (a switch change never rewrites them);
 *  • why a delete is refused, naming the booked months (Hitesh: "kaise pata chalega kis mahine
 *    ki salary book hui hai?") — shown before the delete, never as a red "error caught";
 *  • the ESI ceiling rule for this employee's gross.
 */
import { describe, it, expect } from "vitest";
import {
  bookedStatutoryMonths, bookedStatutoryText, bookedSalaryMonths, deleteBlockMessage, esiRuleNote, hasDeleteBlockers,
} from "./statutory";

const pay = (period: string, pf = 0, esi = 0) => ({ period, pf, esi });
const none = { salaryMonths: [] as string[], projectLabour: 0, expenseClaims: 0 };

describe("bookedStatutoryMonths", () => {
  it("lists only months with PF or ESI, oldest first, one row per month", () => {
    const rows = bookedStatutoryMonths([pay("2026-10", 1800, 0), pay("2026-08", 0, 0), pay("2026-09", 1800, 150), pay("2026-10", 0, 0)]);
    expect(rows).toEqual([
      { period: "2026-09", pf: 1800, esi: 150 },
      { period: "2026-10", pf: 1800, esi: 0 },
    ]);
  });
  it("nothing booked → empty", () => {
    expect(bookedStatutoryMonths([])).toEqual([]);
  });
  it("text: newest 6 written out, older ones counted", () => {
    const months = Array.from({ length: 8 }, (_, i) => ({ period: `2026-0${i + 1}`, pf: 1800, esi: 0 }));
    const t = bookedStatutoryText(months);
    expect(t).toContain("Mar 2026 (PF ₹1,800)");
    expect(t).toContain("Aug 2026 (PF ₹1,800)");
    expect(t).not.toContain("Feb 2026");
    expect(t).toContain("and 2 earlier months");
  });
});

describe("bookedSalaryMonths + deleteBlockMessage", () => {
  it("unique months, oldest first", () => {
    expect(bookedSalaryMonths([{ period: "2026-10" }, { period: "2026-09" }, { period: "2026-10" }])).toEqual(["2026-09", "2026-10"]);
  });
  it("names the months, says what to do instead (English)", () => {
    const m = deleteBlockMessage("Prashant Kumar", { ...none, salaryMonths: ["2026-09", "2026-10"] });
    expect(m).toContain("Prashant Kumar");
    expect(m).toContain("Sep 2026");
    expect(m).toContain("Oct 2026");
    expect(m).toMatch(/Start exit/);
    expect(m).not.toMatch(/hisaab|karo/);
  });
  it("a viewer who cannot start an exit is not told to", () => {
    const m = deleteBlockMessage("A", { ...none, salaryMonths: ["2026-09"] }, false);
    expect(m).not.toMatch(/Start exit/);
    expect(m).toMatch(/untick Active employee/i);
  });
  it("expense claims / project labour block too (same as the DB guard)", () => {
    const b = { ...none, expenseClaims: 1, projectLabour: 2 };
    expect(hasDeleteBlockers(b)).toBe(true);
    expect(hasDeleteBlockers(none)).toBe(false);
    const m = deleteBlockMessage("A", b);
    expect(m).toContain("2 project labour entries");
    expect(m).toContain("1 expense claim");
  });
  it("many months are summarised, not an endless list", () => {
    const months = ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11"];
    const m = deleteBlockMessage("A", { ...none, salaryMonths: months });
    expect(m).toContain("8 months");
    expect(m).toContain("Apr 2025");
    expect(m).toContain("Nov 2025");
  });
});

describe("esiRuleNote", () => {
  it("gross above ₹21,000 → says ESI will be 0", () => {
    expect(esiRuleNote(30_000)).toMatch(/above ₹21,000.*ESI will be ₹0/);
  });
  it("gross at or below ₹21,000 → covered", () => {
    expect(esiRuleNote(21_000)).toMatch(/₹21,000 or less/);
  });
});
