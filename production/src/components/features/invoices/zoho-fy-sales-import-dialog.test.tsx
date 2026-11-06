// @vitest-environment jsdom
/* R-2530 (G-FY2526) — FY sales from Zoho: a Zoho customer whose name matches one app customer but
   whose GSTIN has another PAN is shown as "Use this customer anyway"; ticking it previews again
   with the choice, and the same choice goes with every import part (the server rebuilds the plan).
   fetch is mocked; names and GSTINs are made up. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

import { ZohoFySalesImportDialog } from "./zoho-fy-sales-import-dialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const choice = (chosen: boolean) => ({
  key: "abraf traders", zohoName: "Abraf Traders", customerId: "cust-ab", customerName: "Abraf Traders",
  customerGstin: "07AAMPB0782G1ZV", invoiceGstins: ["07AAHCB0569M1ZD"], count: 12, amount: 236000, chosen,
});
const preview = (chosen: boolean) => ({
  ok: true, scanned: 12, parts: chosen ? 1 : 0,
  counts: { scanned: 12, import: chosen ? 12 : 0, already: 0, skip: chosen ? 0 : 12, voidOrDraft: 0 },
  zohoByMonth: [], importByMonth: [], appByMonth: [], batches: [],
  skipReasons: chosen ? [] : [{ reason: 'Name matches "Abraf Traders" but the GSTIN differs', count: 12 }],
  skipped: [], gstinChoices: [choice(chosen)],
});

describe("R-2530 FY sales dialog — Use this customer anyway", () => {
  it("shows the choice, previews again with the tick, and sends it with the import check", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(b);
      const ticked = !!(b.useAnyway as Record<string, string> | undefined)?.["abraf traders"];
      const json = b.action === "preview" ? preview(ticked) : { ok: true, result: { imported: 12, already: 0, skipped: [] } };
      return { ok: true, json: async () => json } as Response;
    }));

    render(<ZohoFySalesImportDialog open onOpenChange={() => {}} />);
    const box = await screen.findByRole("checkbox", { name: /Use this customer anyway: Abraf Traders/ });
    expect(screen.getByTestId("fy-sales-gstin-choices").textContent).toMatch(/07AAHCB0569M1ZD.*07AAMPB0782G1ZV/);
    expect(bodies[0]).toMatchObject({ action: "preview", useAnyway: {} });

    fireEvent.click(box);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Use this customer anyway/ }).getAttribute("data-state")).toBe("checked"));
    expect(bodies[1]).toMatchObject({ action: "preview", useAnyway: { "abraf traders": "cust-ab" } });

    fireEvent.click(await screen.findByRole("button", { name: /Check first/ }));
    await waitFor(() => expect(bodies.some((b) => b.action === "import")).toBe(true));
    expect(bodies.find((b) => b.action === "import")).toMatchObject({ part: 0, dryRun: true, useAnyway: { "abraf traders": "cust-ab" } });
  });

  it("a failed preview after a tick keeps the old ticks (the box stays unticked, the error shows)", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => preview(false) } as Response;
      return { ok: false, json: async () => ({ ok: false, error: "Could not build the preview. Refresh and try again." }) } as Response;
    }));
    render(<ZohoFySalesImportDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Use this customer anyway/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not build the preview/);
    expect(screen.getByRole("checkbox", { name: /Use this customer anyway/ }).getAttribute("data-state")).toBe("unchecked");
  });
});
