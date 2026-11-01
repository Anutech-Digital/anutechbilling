// @vitest-environment jsdom
/**
 * R-2350 (G-DPDP): Settings → Security log. The owner sees who opened which customer / lead
 * and who exported what, newest first, each record linking to itself; the date filter covers
 * whole IST days; Export CSV writes the same columns. Only the owner gets the menu row.
 */
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen, within } from "@testing-library/react";

import { LogTable } from "./log-table";
import { APP_NAV, filterNavForRole, flattenNav } from "@/lib/nav";
import { atRange, csvRows, CSV_HEADERS, recordHref, recordText, detailText, type SecurityLogRow } from "@/lib/security-log/log";

afterEach(() => cleanup());

const row = (over: Partial<SecurityLogRow>): SecurityLogRow => ({
  id: "a1", user_id: "u-owner", at: "2026-11-02T05:11:00Z", action: "view", record_type: "customer",
  record_id: "c0000000-0000-0000-0000-000000000001", record_label: "E2E Test Co", row_count: null, format: null, ...over,
});
const names: Record<string, string> = { "u-owner": "Pardeep", "u-mgr": "Hitesh" };
const personOf = (id: string | null) => (id ? names[id] ?? "a colleague" : "a removed user");

describe("LogTable", () => {
  it("lists person, action, record and time; customers and leads link to their record", () => {
    render(<LogTable personOf={personOf} rows={[
      row({}),
      row({ id: "a2", user_id: "u-mgr", record_type: "lead", record_id: "L-77", record_label: "Acme Leads" }),
      row({ id: "e1", action: "export", record_type: "export", record_id: null, record_label: "customers", row_count: 42, format: "csv" }),
    ]} />);
    const r1 = within(screen.getByTestId("security-row-a1"));
    expect(r1.getByText("Pardeep")).toBeTruthy();
    expect(r1.getByText("Opened")).toBeTruthy();
    expect(r1.getByText("E2E Test Co").closest("a")?.getAttribute("href")).toBe("/customers/c0000000-0000-0000-0000-000000000001");
    expect(r1.getByText("02 Nov 2026, 10:41 am")).toBeTruthy();

    const r2 = within(screen.getByTestId("security-row-a2"));
    expect(r2.getByText("Hitesh")).toBeTruthy();
    expect(r2.getByText("Acme Leads").closest("a")?.getAttribute("href")).toBe("/leads?lead=L-77");

    const r3 = within(screen.getByTestId("security-row-e1"));
    expect(r3.getByText("Exported")).toBeTruthy();
    expect(r3.getByText("customers").closest("a")).toBeNull();
    expect(r3.getByText("42 rows, CSV")).toBeTruthy();
  });

  it("a deleted record says so and does not link; a removed user is named as such", () => {
    render(<LogTable personOf={personOf} rows={[row({ user_id: null, record_label: null })]} />);
    const r = within(screen.getByTestId("security-row-a1"));
    expect(r.getByText("(deleted record)").closest("a")).toBeNull();
    expect(r.getByText("a removed user")).toBeTruthy();
  });
});

describe("security-log helpers", () => {
  it("a date filter covers whole IST days", () => {
    expect(atRange({ from: "2026-11-01", to: "2026-11-02" })).toEqual({ gte: "2026-11-01T00:00:00+05:30", lt: "2026-11-03T00:00:00+05:30" });
    expect(atRange({ from: "2026-12-31", to: "2026-12-31" }).lt).toBe("2027-01-01T00:00:00+05:30");
    expect(atRange({ from: "", to: "" })).toEqual({});
  });

  it("labels, links and CSV rows", () => {
    expect(recordText(row({ record_label: "  " }))).toBe("(deleted record)");
    expect(recordHref(row({ record_type: "export", record_id: null }))).toBeNull();
    expect(detailText(row({ row_count: 1, format: "xlsx" }))).toBe("1 row, XLSX");
    expect(CSV_HEADERS).toEqual(["When (IST)", "Person", "Action", "Type", "Record", "Details"]);
    expect(csvRows([row({})], personOf)).toEqual([["02 Nov 2026, 10:41 am", "Pardeep", "Opened", "Customer", "E2E Test Co", ""]]);
  });
});

describe("menu: Settings → Security Log is owner-only", () => {
  const has = (role: Parameters<typeof filterNavForRole>[1]) =>
    flattenNav(filterNavForRole(APP_NAV, role)).some((e) => e.item.href === "/settings/security-log");
  it("owner yes; manager, accountant, sales no", () => {
    expect(has("owner")).toBe(true);
    for (const r of ["manager", "accountant", "sales", "billing"] as const) expect(has(r)).toBe(false);
  });
});
