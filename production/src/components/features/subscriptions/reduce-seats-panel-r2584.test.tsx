// @vitest-environment jsdom
//
// R-2584: Reduce seats offers only "Now, with credit". "At end of term" only saved a scheduled
// row — the renewal quote / Renewals / cron never applied it, so the renewal still billed the old
// seats. It stays hidden (SEAT_CUT_END_OF_TERM_ENABLED) until R-2583 applies the cut at renewal.
// A cut that is already scheduled still shows, with its Remove button.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReduceSeatsPanel from "./reduce-seats-panel";
import type { Subscription } from "@/lib/supabase/database.types";

const SUB = { id: "s-1", seats: 10, renewal_date: "2027-04-01" } as unknown as Subscription;

function preview(scheduled: unknown) {
  return {
    seats: 10, renewalDate: "2027-04-01", taxLabel: "IGST 18%", nceLocked: false, nceReason: "", scheduled,
    value: { ok: false, code: "no_days", message: "No unused days." }, preview: null,
  };
}

function renderPanel(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ReduceSeatsPanel sub={SUB} onCancel={() => {}} onDone={() => {}} />
    </QueryClientProvider>,
  );
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Reduce seats panel (R-2584)", () => {
  it("offers only 'Now, with credit' — no 'At end of term' choice", async () => {
    renderPanel(preview(null));
    expect(screen.getByRole("button", { name: "Now, with credit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "At end of term" })).toBeNull();
    await waitFor(() => expect(screen.getByText("No unused days.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^Schedule for / })).toBeNull();
  });
  it("a cut already scheduled still shows, with Remove", async () => {
    renderPanel(preview({ seats_before: 10, seats_after: 8, effective_date: "2027-04-01" }));
    await waitFor(() => expect(screen.getByText(/A seat cut is already scheduled/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Remove scheduled cut" })).toBeTruthy();
  });
});
