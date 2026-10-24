// R-1637 (24 Oct 2026): Online Orders read only the newest 100 orders, and searched and summed
// "Paid this month" over that slice — the 101st order could not be found by its domain and its
// money was missing from the tile. Now the search runs in the database, the month total reads
// every order of the month, and the list pages with "Load more".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORDERS_PAGE, orderSearchOr, monthCreatedRange, fetchOrderLeadsPage, fetchMonthOrderLeads,
} from "./order-query";

interface Call { table: string; or: string[]; eq: [string, string][]; gte?: [string, string]; lt?: [string, string]; range?: [number, number]; count?: string }

function fakeDb(rowsPerCall: (call: Call) => unknown[], total = 0) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, or: [], eq: [] };
      calls.push(call);
      const b = {
        select(_c: string, opts?: { count?: string }) { call.count = opts?.count; return b; },
        or(f: string) { call.or.push(f); return b; },
        eq(c: string, v: string) { call.eq.push([c, v]); return b; },
        gte(c: string, v: string) { call.gte = [c, v]; return b; },
        lt(c: string, v: string) { call.lt = [c, v]; return b; },
        order() { return b; },
        range(a: number, z: number) { call.range = [a, z]; return Promise.resolve({ data: rowsPerCall(call), error: null, count: total }); },
      };
      return b;
    },
  };
  return { db: db as never, calls };
}

describe("orderSearchOr", () => {
  it("searches company, email, contact, domain and order id in the database", () => {
    const or = orderSearchOr("acme.in")!;
    for (const col of ["company", "contact_email", "contact_name", "domain", "id"]) {
      expect(or).toContain(`${col}.ilike."%acme.in%"`);
    }
  });
  it("an order number typed as shown (ORD-0042) finds lead L-0042", () => {
    expect(orderSearchOr("ORD-0042")).toContain('id.ilike."%0042%"');
  });
  it("drops LIKE wildcards and quotes; blank = no filter", () => {
    expect(orderSearchOr('ac%me"')).toContain('company.ilike."%acme%"');
    expect(orderSearchOr("   ")).toBeNull();
  });
});

describe("monthCreatedRange", () => {
  it("is the IST calendar month as UTC instants", () => {
    expect(monthCreatedRange(new Date("2026-10-24T05:00:00Z"))).toEqual({
      from: "2026-09-30T18:30:00.000Z", to: "2026-10-31T18:30:00.000Z",
    });
  });
  it("1 Nov 02:00 IST is already November", () => {
    expect(monthCreatedRange(new Date("2026-10-31T20:30:00Z")).from).toBe("2026-10-31T18:30:00.000Z");
  });
});

describe("fetchOrderLeadsPage", () => {
  it("asks for one page, tenant-scoped, website orders only, plus the search", async () => {
    const { db, calls } = fakeDb(() => [], 342);
    const res = await fetchOrderLeadsPage(db, { tenantId: "t1", search: "acme", limit: ORDERS_PAGE });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("leads");
    expect(calls[0].eq).toContainEqual(["tenant_id", "t1"]);
    expect(calls[0].or[0]).toBe("source.like.buy-%,source.eq.dms-panel");
    expect(calls[0].or[1]).toContain('domain.ilike."%acme%"');
    expect(calls[0].range).toEqual([0, ORDERS_PAGE - 1]);
    expect(calls[0].count).toBe("exact");
    expect(res.total).toBe(342);
  });
  it("Load more asks for the next hundred too", async () => {
    const { db, calls } = fakeDb(() => []);
    await fetchOrderLeadsPage(db, { tenantId: "t1", search: "", limit: 200 });
    expect(calls[0].range).toEqual([0, 199]);
    expect(calls[0].or).toHaveLength(1);
  });
});

describe("fetchMonthOrderLeads", () => {
  it("reads every order created this IST month, past 1000 rows, tenant-scoped", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `L-${i}` }));
    const { db, calls } = fakeDb((c) => (c.range![0] === 0 ? page : [{ id: "L-last" }]));
    const rows = await fetchMonthOrderLeads(db, { tenantId: "t1", now: new Date("2026-10-24T05:00:00Z") });
    expect(rows).toHaveLength(1001);
    expect(calls).toHaveLength(2);
    expect(calls[0].gte).toEqual(["created_at", "2026-09-30T18:30:00.000Z"]);
    expect(calls[0].lt).toEqual(["created_at", "2026-10-31T18:30:00.000Z"]);
    expect(calls[0].eq).toContainEqual(["tenant_id", "t1"]);
    expect(calls[0].or[0]).toBe("source.like.buy-%,source.eq.dms-panel");
  });
});

describe("the page", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/online-orders/page.tsx"), "utf8");
  it("no longer stops at .limit(100)", () => {
    expect(page).not.toMatch(/\.limit\(100\)/);
  });
  it("Paid this month is summed from the month's orders, not the loaded list", () => {
    expect(page).toMatch(/const revenueMtd = monthOrders\b/);
  });
  it("offers Load more while orders are left", () => {
    expect(page).toMatch(/>\s*Load more\s*</);
  });
});
