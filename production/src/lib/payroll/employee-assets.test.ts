import { describe, it, expect } from "vitest";
import { holdings, offboardingChecklist, type EmployeeAssetLike } from "./employee-assets";

const A = (over: Partial<EmployeeAssetLike> & { id: string; kind: EmployeeAssetLike["kind"]; name: string }): EmployeeAssetLike => ({ issued_on: "2026-04-01", ...over });

describe("holdings", () => {
  it("counts open items by group and words the summary", () => {
    const h = holdings([
      A({ id: "1", kind: "laptop", name: "MacBook", identifier: "C02X" }),
      A({ id: "2", kind: "access", name: "Google Workspace" }),
      A({ id: "3", kind: "sim", name: "98xxx" }),
      A({ id: "4", kind: "keys", name: "Office keys" }),
      A({ id: "5", kind: "phone", name: "iPhone", returned_on: "2026-08-01", return_condition: "ok" }),
    ]);
    expect(h.open).toHaveLength(4);
    expect(h.returned).toHaveLength(1);
    expect(h.counts).toEqual({ devices: 1, access: 2, physical: 1 });
    expect(h.summary).toBe("1 device · 2 login/SIM · 1 item");
    expect(holdings([]).summary).toBe("none");
  });
});

describe("offboarding checklist", () => {
  const base = { employeeName: "Asha", isActive: false, assets: [] as EmployeeAssetLike[], loanOutstanding: 0, unpaidSalaries: { count: 0, net: 0 }, lastPeriod: "2026-08", docTypes: ["relieving_letter"] };
  it("clean exit → everything done, ready", () => {
    const c = offboardingChecklist(base);
    expect(c.ready).toBe(true);
    expect(c.items.every((i) => i.status === "done")).toBe(true);
  });
  it("open devices / logins / loan block; unpaid salary and missing letter warn", () => {
    const c = offboardingChecklist({
      ...base, isActive: true, docTypes: [],
      assets: [A({ id: "1", kind: "laptop", name: "MacBook", identifier: "C02X" }), A({ id: "2", kind: "access", name: "GitHub" })],
      loanOutstanding: 5000, unpaidSalaries: { count: 1, net: 20000 },
    });
    const by = Object.fromEntries(c.items.map((i) => [i.key, i.status]));
    expect(by).toEqual({ devices: "todo", access: "todo", physical: "done", loan: "todo", salary: "warn", relieving: "warn" });
    expect(c.items.find((i) => i.key === "devices")!.detail).toMatch(/MacBook \(C02X\)/);
    expect(c.items.find((i) => i.key === "loan")!.detail).toMatch(/₹5,000/);
    expect(c.ready).toBe(false);
  });
  it("returned items no longer block", () => {
    const c = offboardingChecklist({ ...base, assets: [A({ id: "1", kind: "laptop", name: "MacBook", returned_on: "2026-09-01", return_condition: "damaged" })] });
    expect(c.ready).toBe(true);
  });
});
