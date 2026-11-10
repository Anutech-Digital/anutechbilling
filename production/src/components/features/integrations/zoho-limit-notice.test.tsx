// @vitest-environment jsdom
/**
 * R-2652 — when Zoho refuses every read (429 / daily limit) the FY dialogs used to show "bills: 0 of 0"
 * and retry every minute for ever. Now: 3 busy answers in a row → the read stops, the dialog says
 * "Zoho's daily limit is reached — try again after … IST; nothing was changed" with a Try again button,
 * and Try again carries on (no restart). fetch is mocked (never real Zoho); long waits run at once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));

import { ZohoFySalesImportDialog } from "@/components/features/invoices/zoho-fy-sales-import-dialog";
import { ZohoPurchaseImportDialog } from "@/components/features/accounting/zoho-purchase-import-dialog";

const bodies: Array<Record<string, unknown>> = [];
let readsLeftBusy = Infinity;

const salesPreview = {
  ok: true, scanned: 0, parts: 0, counts: { scanned: 0, import: 0, already: 0, skip: 0, voidOrDraft: 0 },
  zohoByMonth: [], importByMonth: [], appByMonth: [], batches: [], skipReasons: [], skipped: [], gstinChoices: [],
};

beforeEach(() => {
  bodies.length = 0;
  readsLeftBusy = Infinity;
  /* The dialogs wait a minute after a busy answer: run every wait of 5 s or more at once (testing-library's own 1 s timeout stays). */
  const real = globalThis.setTimeout;
  vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => real(fn, (ms ?? 0) >= 5000 ? 0 : ms)) as typeof setTimeout);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(b);
    if (b.action === "read") {
      if (readsLeftBusy > 0) { readsLeftBusy--; return new Response(JSON.stringify({ ok: true, listed: 0, detailed: 0, complete: false, busy: true })); }
      return new Response(JSON.stringify({ ok: true, listed: 2, detailed: 2, complete: true, busy: false }));
    }
    /* R-2668: the dialog's first preview answers a little later, as a real server does — so every test
       meets the "Read from Zoho" button while it is still disabled (busy = "preview"). */
    if (b.action === "preview") { await new Promise((r) => setTimeout(r, 50)); return new Response(JSON.stringify(salesPreview)); }
    return new Response(JSON.stringify({ ok: true }));
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const reads = () => bodies.filter((b) => b.action === "read").length;

/* R-2668: the button is disabled while the dialog loads its first preview, and a click then does nothing.
   On CI (faster renders) the tests clicked inside that window, so the read never started — wait for it. */
async function clickReadFromZoho() {
  const button = await screen.findByRole("button", { name: /Read from Zoho/ });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

describe("R-2652 FY sales from Zoho — Zoho's limit", () => {
  it("Zoho busy every time: stops after 3 reads and says the limit plainly, with Try again", async () => {
    render(<ZohoFySalesImportDialog open onOpenChange={() => {}} />);
    await clickReadFromZoho();
    const notice = await screen.findByTestId("zoho-limit-notice");
    expect(notice.textContent).toMatch(/Zoho's daily limit is reached/);
    expect(notice.textContent).toMatch(/Try again after 12:00 am IST on \d+ \w{3} \d{4}/);
    expect(notice.textContent).toMatch(/Nothing was changed/);
    expect(reads()).toBe(3);
    /* No endless retry: nothing more is asked of Zoho on its own. */
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(3);

    /* Zoho answers again → Try again carries on (no restart) and the notice goes. */
    readsLeftBusy = 0;
    const restarts = () => bodies.filter((b) => b.action === "restart").length;
    const restartsBefore = restarts();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("zoho-limit-notice")).toBeNull());
    await waitFor(() => expect(reads()).toBe(4));
    expect(restarts()).toBe(restartsBefore);
  });

  it("one busy answer then Zoho answers: no limit message, the read finishes", async () => {
    readsLeftBusy = 1;
    render(<ZohoFySalesImportDialog open onOpenChange={() => {}} />);
    await clickReadFromZoho();
    expect(await screen.findByText(/Read all 2 invoices/)).toBeTruthy();
    expect(screen.queryByTestId("zoho-limit-notice")).toBeNull();
  });
});

describe("R-2652 FY purchases from Zoho (Expenses) — Zoho's limit", () => {
  it("Zoho busy every time: stops after 3 reads of bills with the same message", async () => {
    render(<ZohoPurchaseImportDialog open onOpenChange={() => {}} />);
    await clickReadFromZoho();
    const notice = await screen.findByTestId("zoho-limit-notice");
    expect(notice.textContent).toMatch(/Zoho's daily limit is reached/);
    expect(reads()).toBe(3);
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(3);
  });
});
