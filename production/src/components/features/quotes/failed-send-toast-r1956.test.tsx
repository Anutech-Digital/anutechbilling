// @vitest-environment jsdom
/**
 * R-1956 (coordinator's localhost check of R-1922, 26 Oct 2026): Sharma Cloud Test, customer
 * messages OFF → New quote → Send via email. The refused-send toast rendered ~1 character per
 * line (sonner's one flex row: two long, non-shrinking buttons left the text ~0px wide), its
 * buttons fell below the viewport, and it timed out before anyone could press them. And
 * "Copy link instead" copied the link of a DRAFT, which the accept page hides.
 *
 * Rendered through the app's real <Toaster /> (sonner), so the classes asserted here are the
 * ones on the DOM the owner sees: text on its own full-width line that wraps by word, buttons
 * in a row under it, and the toast still there a minute later.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { Toaster } from "@/components/ui/toaster";
import { showFailedSendToast, ACTION_TOAST_CLASSNAMES } from "./failed-send-toast";
import { quoteEmailOutcome, type SendQuoteEmailResult } from "@/lib/quotes/send-quote-email";

const LINK = "http://127.0.0.1:3001/quote/Q-1/accept?t=tok";
const refused: SendQuoteEmailResult = {
  status: "failed", email_mode: "real", providerId: null,
  errorMessage: "Customer messages are switched off for this company.",
  recipient: "ravi@acme.in", attachedPdf: true, quoteStatus: "draft",
  refusedReason: "customer_messages_off", customerLink: LINK,
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function showRefused(fetchImpl?: typeof fetch) {
  if (fetchImpl) vi.stubGlobal("fetch", fetchImpl);
  render(<Toaster />);
  act(() => {
    showFailedSendToast({
      out: quoteEmailOutcome(refused, { quoteId: "Q-1" }),
      res: refused, role: "owner", quoteId: "Q-1",
      navigate: () => {},
    });
  });
}

describe("R-1956: the refused-send toast is readable and its buttons are reachable", () => {
  it("text gets its own full-width line that wraps by word; both buttons sit in a row under it", async () => {
    showRefused();
    const toastEl = (await screen.findByText("Email did not go to ravi@acme.in")).closest("[data-sonner-toast]") as HTMLElement;
    expect(toastEl).toBeTruthy();
    // The row wraps — without this the two buttons squeeze the text to ~0px.
    expect(toastEl.className).toContain("flex-wrap");
    const content = toastEl.querySelector("[data-content]") as HTMLElement;
    for (const c of ACTION_TOAST_CLASSNAMES.content.split(" ")) expect(content.className).toContain(c);
    // A full line beside the icon, and breaks at words (sonner's default is overflow-wrap:anywhere).
    expect(content.className).toContain("basis-[calc(100%-24px)]");
    expect(content.className).toContain("[overflow-wrap:break-word]");
    // Both buttons are rendered AFTER the text (so they wrap onto the next line, side by side).
    const buttons = Array.from(toastEl.querySelectorAll("[data-button]")) as HTMLElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(["Copy link instead", "Turn on customer messages"]);
    for (const b of buttons) {
      expect(content.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("a toast with buttons stays until dismissed (it used to vanish after 20s)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    showRefused();
    await screen.findByText("Email did not go to ravi@acme.in");
    await act(async () => { vi.advanceTimersByTime(5 * 60_000); });
    expect(screen.getByText("Email did not go to ravi@acme.in")).toBeTruthy();
    expect(screen.getByText("Copy link instead")).toBeTruthy();
  });

  it("Copy link instead on a draft: marks it sent through /mark-sent FIRST, then copies", async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      order.push(`POST ${url}`);
      return new Response(JSON.stringify({ quoteStatus: "sent", changed: true, leadMoved: false, leadReason: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const writeText = vi.fn(async (t: string) => { order.push(`copy ${t}`); });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    showRefused(fetchImpl);
    fireEvent.click(await screen.findByText("Copy link instead"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK));
    expect(order).toEqual(["POST /api/quotes/Q-1/mark-sent", `copy ${LINK}`]);
    expect(await screen.findByText("Quote marked as sent · customer link copied")).toBeTruthy();
  });

  it("the approval gate refuses: the gate's reason is shown and NOTHING is copied", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "Needs approval first — Discount is 20% — over the 10% that goes out automatically. Ask a manager to approve it." }),
      { status: 409 },
    )) as unknown as typeof fetch;
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    showRefused(fetchImpl);
    fireEvent.click(await screen.findByText("Copy link instead"));
    expect(await screen.findByText("Link not copied — the quote is still a draft")).toBeTruthy();
    expect(screen.getByText(/Needs approval first — Discount is 20%/)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });
});
