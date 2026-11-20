// @vitest-environment jsdom
/* R-2949 (G-RECON) — FY sales from Zoho: the dialog lists the invoices that will be imported
   (number, date, customer, total, TDS / adjustment) before Check first, and the owner leaves some
   out — one row, or every number starting with a prefix. The server keeps the list; the dialog only
   asks it and previews again. fetch is mocked with a tiny stand-in server; names are made up. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

import { ZohoFySalesImportDialog } from "./zoho-fy-sales-import-dialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ALL = [
  { zohoId: "z1", number: "INV/25-26/0001", date: "2025-05-10", customer: "Test Buyer", amount: 1180, tds: 0, tdsSection: null, adjustment: 0 },
  { zohoId: "z2", number: "INV/25-26/0002", date: "2025-06-02", customer: "Second Buyer", amount: 23600, tds: 2000, tdsSection: "194J", adjustment: 0 },
  { zohoId: "z3", number: "LSINV/25-26/0132", date: "2025-06-20", customer: "Third Buyer", amount: 1588, tds: 0, tdsSection: null, adjustment: -250 },
];

/** A stand-in for the route: keeps the left-out list and answers preview from it. */
function server(opts: { failLeaveOut?: boolean } = {}) {
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  const bodies: Array<Record<string, unknown>> = [];
  const by = (r: (typeof ALL)[number]) => (ids.has(r.zohoId) ? { by: "invoice" as const }
    : [...prefixes].filter((p) => r.number.startsWith(p)).map((prefix) => ({ by: "prefix" as const, prefix }))[0] ?? null);
  const preview = () => {
    const toImport = ALL.filter((r) => !by(r));
    const out = ALL.filter((r) => by(r));
    return {
      ok: true, scanned: 3, parts: toImport.length ? 1 : 0,
      counts: { scanned: 3, import: toImport.length, already: 0, skip: out.length, voidOrDraft: 0, leftOutByYou: out.length },
      zohoByMonth: [], importByMonth: [], appByMonth: [], batches: [], skipReasons: [], skipped: [], gstinChoices: [],
      toImport, toImportMore: 0,
      leftOut: {
        prefixes: [...prefixes].map((prefix) => ({ prefix, count: out.filter((r) => by(r)?.by === "prefix").length, amount: 1588 })),
        invoices: out.map((r) => ({ zohoId: r.zohoId, number: r.number, date: r.date, customer: r.customer, amount: r.amount, ...by(r)! })),
      },
    };
  };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(b);
    if (b.action === "leaveOut" && opts.failLeaveOut) return { ok: false, json: async () => ({ ok: false, error: "Could not save what you left out. Try again." }) } as Response;
    if (b.action === "leaveOut" || b.action === "takeBack") {
      const set = typeof b.prefix === "string" ? prefixes : ids;
      const v = typeof b.prefix === "string" ? b.prefix.trim().toUpperCase() : String(b.zohoId);
      if (b.action === "leaveOut") set.add(v); else set.delete(v);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    const json = b.action === "preview" ? preview() : { ok: true, result: { imported: ALL.filter((r) => !by(r)).length, already: 0, skipped: [] } };
    return { ok: true, json: async () => json } as Response;
  }));
  return { bodies };
}

const list = () => within(screen.getByTestId("fy-sales-to-import"));
const mine = () => within(screen.getByTestId("fy-sales-left-out-by-you"));

describe("R-2949 FY sales dialog — the invoices that will be imported", () => {
  it("lists them before Check first: number, date, customer, total, TDS / adjustment", async () => {
    server();
    render(<ZohoFySalesImportDialog open onOpenChange={() => {}} />);
    await screen.findByTestId("fy-sales-to-import");
    const rows = list().getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toMatch(/INV\/25-26\/0001.*10 May 2025.*Test Buyer.*₹1,180/);
    expect(rows[1].textContent).toMatch(/INV\/25-26\/0002.*Second Buyer.*₹23,600.*TDS ₹2,000 \(194J\)/);
    expect(rows[2].textContent).toMatch(/LSINV\/25-26\/0132.*Third Buyer.*₹1,588.*Adjustment .*250/);
    expect(screen.getByRole("button", { name: "Import 3 sales" })).toBeTruthy();
    expect(screen.queryByTestId("fy-sales-left-out-by-you")).toBeNull();
  });

  it("'Leave out numbers starting with LS': asks the server, previews again, shows it under Left out by you; the old check is dropped", async () => {
    const { bodies } = server();
    render(<ZohoFySalesImportDialog open onOpenChange={() => {}} />);
    await screen.findByTestId("fy-sales-to-import");
    fireEvent.click(screen.getByRole("button", { name: /Check first/ }));
    await screen.findByText(/Check result \(nothing saved\): 3 sales/);

    fireEvent.change(screen.getByLabelText("Leave out numbers starting with"), { target: { value: "ls" } });
    fireEvent.click(list().getByRole("button", { name: "Leave out" }));
    await screen.findByRole("button", { name: "Import 2 sales" });

    expect(bodies.find((b) => b.action === "leaveOut")).toMatchObject({ fy: "2025-26", prefix: "ls" });
    expect(bodies.at(-1)).toMatchObject({ action: "preview" });
    expect(list().queryByText("LSINV/25-26/0132")).toBeNull();
    expect(screen.getByText("Left out, and why")).toBeTruthy();
    expect(mine().getByText(/Numbers starting with/).textContent).toMatch(/LS.*1 invoice.*₹1,588/);
    expect(mine().getByText("LSINV/25-26/0132")).toBeTruthy();
    expect(screen.getByTestId("fy-sales-summary").textContent).toMatch(/2 to import.*1 left out/);
    /* The check was for 3 — it no longer matches, so Import waits for a new check. */
    expect(screen.queryByText(/Check result/)).toBeNull();
    expect((screen.getByRole("button", { name: "Import 2 sales" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Leave out numbers starting with") as HTMLInputElement).value).toBe("");
  });

  it("Take back brings it in again", async () => {
    const { bodies } = server();
    render(<ZohoFySalesImportDialog open onOpenChange={() => {}} />);
    await screen.findByTestId("fy-sales-to-import");
    fireEvent.change(screen.getByLabelText("Leave out numbers starting with"), { target: { value: "LS" } });
    fireEvent.click(list().getByRole("button", { name: "Leave out" }));
    fireEvent.click(await screen.findByRole("button", { name: "Take back numbers starting with LS" }));
    await screen.findByRole("button", { name: "Import 3 sales" });
    expect(bodies.find((b) => b.action === "takeBack")).toMatchObject({ prefix: "LS" });
    expect(list().getByText("LSINV/25-26/0132")).toBeTruthy();
    expect(screen.queryByTestId("fy-sales-left-out-by-you")).toBeNull();
  });

  it("one row's Leave out names that invoice; its Take back names it too", async () => {
    const { bodies } = server();
    render(<ZohoFySalesImportDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Leave out INV/25-26/0002" }));
    await screen.findByRole("button", { name: "Import 2 sales" });
    expect(bodies.find((b) => b.action === "leaveOut")).toMatchObject({ zohoId: "z2" });
    expect(bodies.find((b) => b.action === "leaveOut")).not.toHaveProperty("prefix");
    expect(mine().getByText("INV/25-26/0002")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Take back INV/25-26/0002" }));
    await screen.findByRole("button", { name: "Import 3 sales" });
    expect(bodies.find((b) => b.action === "takeBack")).toMatchObject({ zohoId: "z2" });
  });

  it("every import part goes out without naming invoices — the server's list decides", async () => {
    const { bodies } = server();
    render(<ZohoFySalesImportDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Leave out LSINV/25-26/0132" }));
    await screen.findByRole("button", { name: "Import 2 sales" });
    fireEvent.click(screen.getByRole("button", { name: /Check first/ }));
    await screen.findByText(/Check result \(nothing saved\): 2 sales/);
    const sent = bodies.find((b) => b.action === "import")!;
    expect(Object.keys(sent).sort()).toEqual(["action", "dryRun", "fy", "part", "useAnyway"]);
  });

  it("a prefix under 2 characters is not sent; a failed save shows the error and changes nothing", async () => {
    const { bodies } = server({ failLeaveOut: true });
    render(<ZohoFySalesImportDialog open onOpenChange={() => {}} />);
    await screen.findByTestId("fy-sales-to-import");
    fireEvent.change(screen.getByLabelText("Leave out numbers starting with"), { target: { value: " L " } });
    expect((list().getByRole("button", { name: "Leave out" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Leave out numbers starting with"), { target: { value: "LS" } });
    fireEvent.click(list().getByRole("button", { name: "Leave out" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not save what you left out/);
    await waitFor(() => expect(bodies.filter((b) => b.action === "leaveOut")).toHaveLength(1));
    expect(list().getByText("LSINV/25-26/0132")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import 3 sales" })).toBeTruthy();
    expect((screen.getByLabelText("Leave out numbers starting with") as HTMLInputElement).value).toBe("LS");
  });
});
