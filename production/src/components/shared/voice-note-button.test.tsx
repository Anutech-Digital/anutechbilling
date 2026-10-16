// @vitest-environment jsdom
//
// R-1452 — Renewals "🔊 Voice" for a customer with no phone used to fire the send and show
// the route's bare 400. Now the button looks up the phone first: none → a §24 toast
// ("No phone number for this customer — add one", why, "Open customer" button) and NO
// voice-note request, NO confirm. With a phone it confirms and sends exactly as before.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) } }));

const confirm = vi.fn();
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => confirm }));

const lookup = vi.hoisted(() => ({ phone: null as string | null, error: null as null | { message: string } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      expect(table).toBe("customers");
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: () => Promise.resolve({
          data: lookup.error ? null : { contact_phone: lookup.phone },
          error: lookup.error,
        }),
      };
      return q;
    },
  }),
}));

import { VoiceNoteButton } from "./voice-note-button";

const fetchMock = vi.fn();

beforeEach(() => {
  push.mockReset(); toastError.mockReset(); toastSuccess.mockReset(); confirm.mockReset(); fetchMock.mockReset();
  lookup.phone = null; lookup.error = null;
  confirm.mockResolvedValue(true);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ sent: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function press() {
  render(<VoiceNoteButton customerId="c1" purpose="renewal" customerName="Ravi Traders" label="🔊 Voice" />);
  fireEvent.click(screen.getByRole("button", { name: "🔊 Voice" }));
}

describe("VoiceNoteButton — R-1452 no phone", () => {
  it("no phone on file → §24 toast with Open customer, no confirm, no send", async () => {
    lookup.phone = "  ";
    press();
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const [msg, opts] = toastError.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }];
    expect(msg).toBe("No phone number for this customer — add one");
    expect(opts.description).toContain("Ravi Traders");
    expect(opts.action.label).toBe("Open customer");
    opts.action.onClick();
    expect(push).toHaveBeenCalledWith("/customers/c1");
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("route still says no_phone (race) → same actionable toast, not a bare one", async () => {
    lookup.phone = "+91 98765 43210";
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      code: "no_phone", error: "No phone number for this customer — add one",
      description: "Nothing was sent.", href: "/customers/c1",
    }), { status: 422 }));
    press();
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    const [msg, opts] = toastError.mock.calls[0] as [string, { action?: { label: string } }];
    expect(msg).toBe("No phone number for this customer — add one");
    expect(opts.action?.label).toBe("Open customer");
  });

  it("with a phone → confirms and sends as before", async () => {
    lookup.phone = "+91 98765 43210";
    press();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/voice/whatsapp-note");
    expect(toastError).not.toHaveBeenCalled();
  });
});
