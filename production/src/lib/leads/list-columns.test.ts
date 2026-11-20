/**
 * R-2970 — the lead list's columns: phone + email shown by default, the Columns menu can
 * add / remove / move, the choice is remembered, and the default fits 1280.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAD_COLS, LEAD_COL_DEFS, LEAD_COLS_KEY, LEGACY_HIDDEN_KEY, ALL_LEAD_COL_IDS,
  addColumn, addableColumns, canMove, fallbackPercents, keepWhole, moveColumn, normaliseShown,
  readShownColumns, removeColumn, renderOrder, writeShownColumns, CONTROL_PX,
} from "@/lib/leads/list-columns";
import { LEAD_LIST_COLUMNS } from "@/lib/leads/list-page";
import { fitToContainer } from "@/lib/leads/use-column-widths";

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    m,
  };
}

describe("R-2970 default view", () => {
  it("shows phone and email by default, right after the contact", () => {
    expect(DEFAULT_LEAD_COLS.slice(0, 3)).toEqual(["contact", "phone", "email"]);
    expect(DEFAULT_LEAD_COLS).toEqual(["contact", "phone", "email", "company", "stage", "value", "followup", "owner"]);
  });

  it("moves Plan, Seats and Wait to 'Add a column' (they do not fit 1280 with phone + email)", () => {
    for (const id of ["plan", "seats", "wait"] as const) {
      expect(DEFAULT_LEAD_COLS).not.toContain(id);
      expect(addableColumns(DEFAULT_LEAD_COLS)).toContain(id);
    }
  });

  it("offers only fields the list row already carries — no new data", () => {
    const field: Record<string, string> = {
      contact: "contact_name", phone: "contact_phone", email: "contact_email", company: "company",
      stage: "stage", value: "value", followup: "follow_up_date", owner: "owner_id", plan: "plan",
      seats: "seats", wait: "created_at", source: "source", created: "created_at",
      updated: "updated_at", domain: "domain",
    };
    for (const d of LEAD_COL_DEFS) {
      expect(field[d.id], d.id).toBeTruthy();
      expect(LEAD_LIST_COLUMNS as readonly string[]).toContain(field[d.id]);
    }
  });

  it("the default view's natural widths fit the 1006px grid at 1280 once the text columns give way", () => {
    // Natural widths measured on localhost 20 Nov 2026 (widest real cell + padding).
    const natural: Record<string, number> = {
      select: 40, contact: 180, phone: 120, email: 190, company: 127, stage: 140,
      value: 82, followup: 98, owner: 109, actions: 44,
    };
    const order = renderOrder(DEFAULT_LEAD_COLS);
    const widths = Object.fromEntries(order.map((k) => [k, natural[k]]));
    const fit = fitToContainer(widths, 1006, { shrink: true, keep: keepWhole(DEFAULT_LEAD_COLS) });
    expect(Object.values(fit).reduce((s, w) => s + w, 0)).toBeLessThanOrEqual(1006);
    // Money, date and phone stay whole.
    expect(fit.value).toBe(82);
    expect(fit.followup).toBe(98);
    expect(fit.phone).toBe(120);
    expect(fit.select).toBe(40);
    expect(fit.actions).toBe(44);
    // Key order is the render order (the colgroup reads it).
    expect(Object.keys(fit)).toEqual(order);
  });

  it("first-paint percentages cover exactly the shown columns", () => {
    const p = fallbackPercents(DEFAULT_LEAD_COLS);
    expect(Object.keys(p)).toEqual([...DEFAULT_LEAD_COLS]);
    const sum = Object.values(p).reduce((s, v) => s + parseFloat(v), 0);
    expect(Math.abs(sum - 100)).toBeLessThan(0.1);
    expect(CONTROL_PX.select).toBe(40);
  });
});

describe("R-2970 add / remove / move", () => {
  it("adds a column at the end and removes it again in one step", () => {
    const withSource = addColumn(DEFAULT_LEAD_COLS, "source");
    expect(withSource.at(-1)).toBe("source");
    expect(addableColumns(withSource)).not.toContain("source");
    expect(removeColumn(withSource, "source")).toEqual([...DEFAULT_LEAD_COLS]);
  });

  it("never removes or moves the contact (the sticky identity column)", () => {
    expect(removeColumn(DEFAULT_LEAD_COLS, "contact")).toEqual([...DEFAULT_LEAD_COLS]);
    expect(moveColumn(DEFAULT_LEAD_COLS, "contact", 1)).toEqual([...DEFAULT_LEAD_COLS]);
    expect(moveColumn(DEFAULT_LEAD_COLS, "phone", -1)).toEqual([...DEFAULT_LEAD_COLS]);
    expect(canMove(DEFAULT_LEAD_COLS, "phone", -1)).toBe(false);
    expect(canMove(DEFAULT_LEAD_COLS, "owner", 1)).toBe(false);
  });

  it("moves a column one step up or down", () => {
    expect(moveColumn(DEFAULT_LEAD_COLS, "email", -1).slice(0, 3)).toEqual(["contact", "email", "phone"]);
    expect(moveColumn(DEFAULT_LEAD_COLS, "value", 1).slice(5, 7)).toEqual(["followup", "value"]);
    expect(canMove(DEFAULT_LEAD_COLS, "email", -1)).toBe(true);
  });

  it("normalises any stored list: contact first, known ids, no repeats", () => {
    expect(normaliseShown(["email", "bogus", "email", "contact", 7, "plan"])).toEqual(["contact", "email", "plan"]);
    expect(normaliseShown([])).toEqual(["contact"]);
  });

  it("render order wraps the data columns with the checkbox and the ⋯", () => {
    expect(renderOrder(["contact", "phone"])).toEqual(["select", "contact", "phone", "actions"]);
  });

  it("every column has a unique id", () => {
    expect(new Set(ALL_LEAD_COL_IDS).size).toBe(ALL_LEAD_COL_IDS.length);
  });
});

describe("R-2970 remembered choice", () => {
  it("round-trips the shown columns and their order", () => {
    const s = memStore();
    const mine = moveColumn(addColumn(DEFAULT_LEAD_COLS, "source"), "source", -1);
    writeShownColumns(mine, s);
    expect(readShownColumns(s)).toEqual(mine);
  });

  it("falls back to the default when nothing or something broken is stored", () => {
    expect(readShownColumns(memStore())).toEqual([...DEFAULT_LEAD_COLS]);
    expect(readShownColumns(memStore({ [LEAD_COLS_KEY]: "{not json" }))).toEqual([...DEFAULT_LEAD_COLS]);
    expect(readShownColumns(memStore({ [LEAD_COLS_KEY]: "{\"a\":1}" }))).toEqual([...DEFAULT_LEAD_COLS]);
  });

  it("keeps a column hidden under the old menu hidden", () => {
    const s = memStore({ [LEGACY_HIDDEN_KEY]: JSON.stringify(["owner", "plan"]) });
    const shown = readShownColumns(s);
    expect(shown).not.toContain("owner");
    expect(shown).toContain("phone");
    expect(shown).toContain("email");
  });

  it("a store that throws (private mode) still gives the default", () => {
    const bad = { getItem: () => { throw new Error("denied"); } };
    expect(readShownColumns(bad)).toEqual([...DEFAULT_LEAD_COLS]);
    expect(() => writeShownColumns(DEFAULT_LEAD_COLS, { setItem: () => { throw new Error("quota"); } })).not.toThrow();
  });
});
