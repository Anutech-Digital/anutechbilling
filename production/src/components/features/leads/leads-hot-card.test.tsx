// @vitest-environment jsdom
//
// R-1476 (Pawan, staging AI Help, 16 Oct 2026, Deals): the "Lead intelligence · Today" card
// read "Call DEMO" — the first word of the company label "DEMO · Prospect 5" — and the lead
// had no phone, so the button could only fail. Same rule as R-1426's call queue: a lead with
// no dialable number offers "Add phone number" (opens the lead), never a Call that fails; a
// lead with one names the CONTACT and dials.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), info: vi.fn() } }));

import { LeadsHotCard, type LeadsHotCardProps } from "./leads-hot-card";

afterEach(() => { cleanup(); toastError.mockReset(); });

type Top = NonNullable<LeadsHotCardProps["topHot"]>;

function top(over: Partial<Top>): Top {
  return {
    id: "L-1", company: "DEMO · Prospect 5", contact_name: null, contact_email: null,
    contact_phone: null, plan: null, value: 0, stage: "quote", ...over,
  } as Top;
}

function renderCard(topHot: Top) {
  const onOpenLead = vi.fn();
  render(
    <LeadsHotCard
      hotCount={1}
      topHot={topHot}
      currentUser={undefined}
      tipsOpen
      toggleTips={() => {}}
      onOpenLead={onOpenLead}
    />,
  );
  return { onOpenLead };
}

describe("LeadsHotCard — Call button (R-1476)", () => {
  it("no phone: no 'Call DEMO'; 'Add phone number' opens the lead, no error toast", () => {
    const { onOpenLead } = renderCard(top({ contact_phone: null }));
    expect(screen.queryByText(/Call DEMO/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Call/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add phone number/ }));
    expect(onOpenLead).toHaveBeenCalledWith(expect.objectContaining({ id: "L-1" }));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("an undialable number ('NA') is treated as no phone", () => {
    renderCard(top({ contact_phone: "NA", contact_name: "Raj Kumar" }));
    expect(screen.queryByRole("link", { name: /Call/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Add phone number/ })).toBeTruthy();
  });

  it("with a phone: the button names the contact (not the company's first word) and dials", () => {
    renderCard(top({ contact_phone: "98100 00000", contact_name: "Raj Kumar" }));
    const call = screen.getByRole("link", { name: /Call Raj/ });
    expect(call.getAttribute("href")).toBe("tel:+919810000000");
    expect(screen.queryByText(/Call DEMO/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Add phone number/ })).toBeNull();
  });

  it("with a phone but no contact name: a plain 'Call now', never a word of the company", () => {
    renderCard(top({ contact_phone: "9810000000" }));
    expect(screen.getByRole("link", { name: /Call now/ })).toBeTruthy();
    expect(screen.queryByText(/Call DEMO/)).toBeNull();
  });
});
