// @vitest-environment jsdom
//
// R-1426 (Pawan, staging, 12 Oct 2026, Deals): pressing "Call" on a lead without a usable
// phone number showed an error toast. /deals renders the Leads page, so this is the
// priority call queue's "Call now". A lead with no dialable number must not offer a Call
// that fails — it offers the fix (open the lead to add the number) and never toasts.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

import { PriorityCallQueue } from "./priority-call-queue";
import type { LeadListRow } from "@/lib/leads/list-page";

afterEach(() => { cleanup(); toastError.mockReset(); });

const today = new Date().toISOString().slice(0, 10);

function lead(id: string, phone: string | null): LeadListRow {
  return {
    id, company: `Co ${id}`, contact_name: null, contact_phone: phone, contact_email: null,
    stage: "quote", follow_up_date: today, is_junk: false, value: 0, plan: null, seats: null,
  } as unknown as LeadListRow;
}

function renderQueue(rows: LeadListRow[]) {
  const onOpen = vi.fn();
  const onLogCall = vi.fn();
  render(
    <PriorityCallQueue
      leads={rows}
      onOutcome={() => {}}
      onOpen={onOpen}
      onLogCall={onLogCall}
      onLogWhatsApp={() => {}}
    />,
  );
  return { onOpen, onLogCall };
}

describe("PriorityCallQueue — Call with no usable number (R-1426)", () => {
  it("offers no Call link when the number cannot be dialled; the button opens the lead instead", () => {
    const { onOpen, onLogCall } = renderQueue([lead("L-1", "NA")]);
    expect(screen.queryByRole("link", { name: /Call now/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /WhatsApp/ })).toBeNull();
    const fix = screen.getByRole("button", { name: /Add phone number/ });
    expect(fix.getAttribute("title")).toMatch(/No usable phone number/);
    fireEvent.click(fix);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onLogCall).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("a valid number keeps its tel: Call link and logs the call", () => {
    const { onLogCall } = renderQueue([lead("L-2", "98765 43210")]);
    const call = screen.getByRole("link", { name: /Call now/ });
    expect(call.getAttribute("href")).toBe("tel:919876543210");
    fireEvent.click(call);
    expect(onLogCall).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Add phone number/ })).toBeNull();
  });
});
