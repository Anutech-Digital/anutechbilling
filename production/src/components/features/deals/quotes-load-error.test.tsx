// @vitest-environment jsdom
//
// R-1806 — a failed quotes-by-lead read is an error, not "no quotes".
// useQuotesByLead() throws on a PostgREST error, but the lead drawer read it as
// `{ data: quotesForLead = [] }` and the deal page as `quotesQ.data ?? []` without looking at
// isError: the deal page said "No quotes yet", the drawer hid its Quotes section, and Delete's
// "never with a quote" check ran against an empty list. Both panels now show the §24 error
// state with Try again.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { DealQuotesCard, DealMoneyCard } from "./deal-side-cards";
import { LeadQuotesSection } from "@/components/features/leads/lead-detail-details-tab";
import { dealDeleteBlock } from "@/lib/deals/delete-rules";
import type { Lead } from "@/lib/supabase/database.types";

afterEach(cleanup);

const failure = { message: "permission denied for table quotes", code: "42501" };

describe("deal page Quotes card (R-1806)", () => {
  it("a failed read shows the error + Try again, not 'No quotes yet'", () => {
    const onRetry = vi.fn();
    render(<DealQuotesCard rows={[]} onNewQuote={() => {}} error={failure} onRetry={onRetry} />);
    expect(screen.queryByText(/no quotes yet/i)).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/Quotes didn.t load/);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("an empty list that DID load still says 'No quotes yet'", () => {
    render(<DealQuotesCard rows={[]} onNewQuote={() => {}} />);
    expect(screen.getByText(/no quotes yet/i)).toBeTruthy();
  });

  it("Payments card does not say 'appear here after a quote' when quotes failed", () => {
    const money = {
      invoiced: 0, paid: 0, outstanding: null, invoiceCount: 0, paymentCount: 0,
      project: { value: 0, notInvoiced: 0, tds: 0 },
    } as unknown as React.ComponentProps<typeof DealMoneyCard>["money"];
    render(<DealMoneyCard money={money} subscriptions={0} failed hasQuotes={false} />);
    expect(screen.queryByText(/appear here after a quote/i)).toBeNull();
    expect(document.body.textContent).toMatch(/didn't load/);
  });
});

describe("lead drawer Quotes section (R-1806)", () => {
  const lead = { id: "L-1", stage: "quote" } as Lead;

  it("a failed read shows the error + Try again", () => {
    const onRetry = vi.fn();
    render(<LeadQuotesSection lead={lead} quotes={[]} latestQuote={undefined} error={failure} onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toMatch(/Quotes didn.t load/);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("no quotes that DID load renders nothing (as before)", () => {
    const { container } = render(<LeadQuotesSection lead={lead} quotes={[]} latestQuote={undefined} />);
    expect(container.textContent).toBe("");
  });
});

describe("Delete is not allowed while the quotes are unknown (R-1806)", () => {
  it("quotesFailed blocks delete with a reason", () => {
    const block = dealDeleteBlock({ role: "owner", quoteIds: [], quotesFailed: true });
    expect(block).toMatch(/quotes/i);
  });
  it("loaded and empty still allows the owner", () => {
    expect(dealDeleteBlock({ role: "owner", quoteIds: [] })).toBeNull();
  });
});
