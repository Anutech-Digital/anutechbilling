// @vitest-environment jsdom
/**
 * R-1753 — Import from Zoho: Dry run → reading → counts + problems → Import → Undo import.
 * The server is faked; Zoho is never called. Made-up T- data.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true, useAskText: () => async () => "T-wrong org" }));

import { ZohoBooksImportDialog, phaseText, type RunView } from "./zoho-books-import-dialog";

const run = (o: Partial<RunView>): RunView => ({
  id: "c1753000-0000-4000-8000-0000000f0001", phase: "contacts", since: "2024-10-22", months: 24,
  contacts_read: 0, invoices_read: 0, details_total: 0, details_done: 0, last_error: null,
  imported_at: null, undone_at: null, result: null, ...o,
});

let state: { open: RunView | null; last: RunView | null; steps: number };
let posts: Array<Record<string, unknown>>;

beforeEach(() => {
  posts = [];
  state = { open: null, last: null, steps: 0 };
  toastMock.mockReset(); toastMock.success.mockReset(); toastMock.error.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (init?.method !== "POST") return j({ ok: true, open: state.open, last_import: state.last });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    posts.push(body);
    if (body.action === "start") { state.open = run({ months: Number(body.months) }); return j({ ok: true, open: state.open }); }
    if (body.action === "step") {
      state.steps += 1;
      state.open = state.steps === 1
        ? run({ phase: "details", contacts_read: 2, invoices_read: 3, details_total: 2, details_done: 1 })
        : run({ phase: "ready", contacts_read: 2, invoices_read: 3, details_total: 2, details_done: 2 });
      return j({ ok: true, open: state.open, rate_limited: false });
    }
    if (body.action === "dry_run") {
      return j({ ok: true, summary: {
        counts: { contacts: 2, customersNew: 1, customersExisting: 1, subscriptionsToImport: 1, subscriptionsAlready: 0, subscriptionsEnded: 0,
          oneTimeInvoices: 1, invoicesToImport: 1, invoicesAlready: 0 },
        totals: { mrr: 750, openBalance: 1180 },
        problems: [{ code: "no_period", label: "Subscription line with no period (not imported)", blocks: true, count: 1,
          examples: ["INV-T-004 · Google Workspace Business Starter (t-gamma.in): no period."] }],
      } });
    }
    if (body.action === "import") {
      state.last = run({ phase: "ready", imported_at: "2026-10-22T08:00:00Z",
        result: { customers_created: 1, customers_existing: 1, subscriptions_created: 1, invoices_imported: 1 } });
      state.open = null;
      return j({ ok: true, result: state.last.result });
    }
    if (body.action === "undo") { state.last = { ...state.last!, undone_at: "2026-10-22T08:05:00Z" }; return j({ ok: true }); }
    return j({ ok: false, error: "?" }, 400);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Import from Zoho dialog", () => {
  it("dry run reads Zoho, shows counts + problems; Import sends one import; Undo import sends the batch id", async () => {
    render(<ZohoBooksImportDialog open onOpenChange={() => undefined} orgName="T-Acme Org" />);
    expect(await screen.findByText(/Nothing is imported until you press Import/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Dry run" }));

    expect(await screen.findByTestId("zoho-dry-run", {}, { timeout: 3000 })).toBeTruthy();
    expect(posts.map((p) => p.action)).toEqual(["start", "step", "step", "dry_run"]);
    expect(posts[0].months).toBe(24);
    expect(screen.getByText(/last 24 months/)).toBeTruthy();
    expect(screen.getByText("Live subscriptions")).toBeTruthy();
    expect(screen.getByText(/Subscription line with no period/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ action: "import" }));
    expect(await screen.findByTestId("zoho-last-import")).toBeTruthy();
    expect(screen.getByText(/1 customers, 1 subscriptions, 1 open invoices/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Undo import" }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ action: "undo", run_id: "c1753000-0000-4000-8000-0000000f0001", reason: "T-wrong org" }));
    await waitFor(() => expect(screen.queryByTestId("zoho-last-import")).toBeNull());
  });

  it("an unfinished dry run is offered to Continue, with progress and time left", async () => {
    state.open = run({ phase: "details", details_total: 850, details_done: 340 });
    render(<ZohoBooksImportDialog open onOpenChange={() => undefined} orgName="T-Acme Org" />);
    expect(await screen.findByText("Reading invoice lines 340 of 850 · about 6 min left")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(phaseText(run({ phase: "contacts", contacts_read: 1565 }))).toBe("Reading customers from Zoho… 1,565 so far");
  });
});
