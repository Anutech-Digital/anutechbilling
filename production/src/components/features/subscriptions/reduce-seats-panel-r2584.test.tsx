// @vitest-environment jsdom
//
// R-2584 hid "At end of term" (the renewal never applied a scheduled cut). R-2608 shows it again —
// the renewal quote bills the cut (R-2583). Where it cannot be saved (billed in parts, a renewal
// quote already made) the dialog says why and the Schedule button stays off. A cut that is already
// scheduled still shows, with its Remove button.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReduceSeatsPanel from "./reduce-seats-panel";
import type { Subscription } from "@/lib/supabase/database.types";

const SUB = { id: "s-1", seats: 10, renewal_date: "2027-04-01" } as unknown as Subscription;

function preview(scheduled: unknown, endOfTermBlockedReason: string | null = null) {
  return {
    seats: 10, renewalDate: "2027-04-01", taxLabel: "IGST 18%", nceLocked: false, nceReason: "", scheduled,
    value: { ok: false, code: "no_days", message: "No unused days." }, preview: null, endOfTermBlockedReason,
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

describe("Reduce seats panel (R-2584 → R-2608)", () => {
  it("offers 'Now, with credit' and 'At end of term'; end of term schedules for the renewal date", async () => {
    renderPanel(preview(null));
    expect(screen.getByRole("button", { name: "Now, with credit" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "At end of term" }));
    await waitFor(() => expect(screen.getByTestId("reduce-seats-eot")).toBeTruthy());
    await waitFor(() => expect((screen.getByRole("button", { name: /^Schedule for / }) as HTMLButtonElement).disabled).toBe(false));
  });
  it("R-2608: a renewal quote already made → the reason shows and Schedule stays off", async () => {
    const why = "Renewal quote QT-1 is already made for 10 seats. Delete that quote first, then schedule the cut — the renewal quote is made again with the cut.";
    renderPanel(preview(null, why));
    fireEvent.click(screen.getByRole("button", { name: "At end of term" }));
    await waitFor(() => expect(screen.getByTestId("reduce-seats-eot-blocked").textContent).toBe(why));
    expect((screen.getByRole("button", { name: /^Schedule for / }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("a cut already scheduled still shows, with Remove", async () => {
    renderPanel(preview({ seats_before: 10, seats_after: 8, effective_date: "2027-04-01" }));
    await waitFor(() => expect(screen.getByText(/A seat cut is already scheduled/)).toBeTruthy());
    expect(screen.getByText(/Remove it to make a different cut/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove scheduled cut" })).toBeTruthy();
  });
});
