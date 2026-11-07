// @vitest-environment jsdom
/* R-2547 (G-FY2526) — FY receipts from Zoho: a part that fails (staging 7 Nov: "canceling statement due
   to statement timeout" on part 2) is named with its reason and STAYS on screen after the preview
   refresh that follows the import; what the earlier parts saved is shown; every skip reason is listed
   (not only the first 8). fetch is mocked; names and numbers are made up. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

import { ZohoFyReceiptsImportDialog, partFailedMessage } from "./zoho-fy-receipts-import-dialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const reasons = Array.from({ length: 11 }, (_, i) => ({ reason: `Reason number ${i + 1}`, count: i + 1 }));
const preview = {
  ok: true, parts: 3,
  counts: { scanned: 160, import: 120, already: 0, alreadyNotBanked: 0, skip: 40 },
  totals: { cash: 100000, tds: 0, excess: 0 },
  deposits: [], accounts: [], skipReasons: reasons, skipped: [], batches: [], canRemove: true,
};
const partOk = (n: number) => ({ ok: true, result: { imported: n, already: 0, banked: n, bank_later: 0, skipped: [] } });

describe("R-2547 FY receipts dialog", () => {
  it("names the failed part and its reason, keeps it after the refresh, and shows what earlier parts saved", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(b);
      if (b.action === "preview") return { ok: true, json: async () => preview } as Response;
      if (b.dryRun === false && b.part === 1) {
        return { ok: false, json: async () => ({ ok: false, error: "canceling statement due to statement timeout" }) } as Response;
      }
      return { ok: true, json: async () => partOk(50) } as Response;
    }));

    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Check first/ }));
    const importBtn = await screen.findByRole("button", { name: /Import 120 receipts/ });
    await waitFor(() => expect(importBtn.hasAttribute("disabled")).toBe(false));
    fireEvent.click(importBtn);

    await waitFor(() => expect(bodies.filter((b) => b.action === "preview").length).toBe(2));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Part 2 of 3/);
    expect(alert.textContent).toMatch(/took too long/);
    expect(alert.textContent).toMatch(/nothing is booked twice/);
    /* part 3 was never sent once part 2 failed */
    expect(bodies.some((b) => b.action === "import" && b.dryRun === false && b.part === 2)).toBe(false);
    expect(screen.getByText(/Recorded: 50 receipts/)).toBeTruthy();
  });

  it("lists every skip reason (11), not only the first 8", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => preview }) as Response));
    render(<ZohoFyReceiptsImportDialog open onOpenChange={() => {}} />);
    expect(await screen.findByText(/Reason number 11/)).toBeTruthy();
    expect(screen.getByText(/Reason number 9/)).toBeTruthy();
  });

  it("partFailedMessage: plain words for the timeout; other refusals as the database gave them", () => {
    expect(partFailedMessage(0, 4, "canceling statement due to statement timeout", 0)).toMatch(/^Part 1 of 4 stopped: .*took too long/);
    const m = partFailedMessage(2, 4, "Only the owner or an accountant can import FY receipts from Zoho.", 100);
    expect(m).toMatch(/^Part 3 of 4 stopped: Only the owner/);
    expect(m).toMatch(/Parts 1–2 are saved \(100 receipts\)/);
  });
});
