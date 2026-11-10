// @vitest-environment jsdom
//
// R-2605: an open plan-change quote blocks any seat cut (R-2589). The panel used to say so only
// after Confirm (the POST's 409). Now the GET's planChangeBlockedReason shows at once, with a link
// to the quote, and the button stays off for both timings.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReduceSeatsPanel from "./reduce-seats-panel";
import type { Subscription } from "@/lib/supabase/database.types";

const SUB = { id: "s-1", seats: 10, renewal_date: "2027-04-01" } as unknown as Subscription;
const WHY = "Plan change quote Q-PC-7 is open for this subscription — it was priced on today's seats. Delete that quote (or record its payment) first, then reduce seats.";

function preview(planChangeQuoteId: string | null) {
  return {
    seats: 10, renewalDate: "2027-04-01", taxLabel: "IGST 18%", nceLocked: false, nceReason: "", scheduled: null,
    value: {
      ok: true, seatsBefore: 10, seatsRemoved: 1, seatsAfter: 9, annualPerSeat: 1800, days: 100, partEnd: "2027-03-31",
      instalmentPart: false, subtotal: 493, tax: 89, total: 582, newMrr: 1350,
    },
    preview: { canReduceNow: true, blockedReason: null, invoice: null, split: { lines: [], documentPaise: 0 } },
    endOfTermBlockedReason: null,
    planChangeQuoteId,
    planChangeBlockedReason: planChangeQuoteId ? WHY : null,
  };
}

function renderPanel(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ReduceSeatsPanel sub={SUB} onCancel={() => {}} onDone={() => {}} />
    </QueryClientProvider>,
  );
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Reduce seats panel — open plan-change quote (R-2605)", () => {
  it("shows the reason with a link to the quote before Confirm; Remove now stays off", async () => {
    renderPanel(preview("Q-PC-7"));
    await waitFor(() => expect(screen.getByTestId("reduce-seats-plan-change-blocked").textContent).toContain(WHY));
    const link = screen.getByRole("link", { name: "Open quote Q-PC-7" });
    expect(link.getAttribute("href")).toBe("/quotes/Q-PC-7");
    expect((screen.getByRole("button", { name: /^Remove 1 seat now/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("end of term is off too", async () => {
    renderPanel(preview("Q-PC-7"));
    fireEvent.click(screen.getByRole("button", { name: "At end of term" }));
    await waitFor(() => expect(screen.getByTestId("reduce-seats-plan-change-blocked")).toBeTruthy());
    expect((screen.getByRole("button", { name: /^Schedule for / }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("no plan-change quote → no note, the button works", async () => {
    renderPanel(preview(null));
    await waitFor(() => expect((screen.getByRole("button", { name: /^Remove 1 seat now/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("reduce-seats-plan-change-blocked")).toBeNull();
  });
});
