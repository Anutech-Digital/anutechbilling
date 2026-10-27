// @vitest-environment jsdom
/**
 * R-1961 (found by the R-1956 worker, 26 Oct 2026): the quote page's "Send on WhatsApp" (free
 * wa.me / web.whatsapp share) and the WhatsApp dialog (Cloud API) sent the customer's accept link
 * while the quote was still a DRAFT. The accept page hides drafts (app/(public)/quote/[id]/accept
 * + visibility.ts), so the customer got a dead link.
 *
 * Every share of the link now goes through ONE helper (share-marking-sent.ts) — the same one
 * "Copy customer link" / "Copy link instead" use: a draft is marked sent through
 * POST /api/quotes/[id]/mark-sent (approval gate included) BEFORE the link leaves the app.
 * The free share opens its tab inside the click (about:blank — pop-up blockers only allow a
 * window opened in the click itself) and points it at WhatsApp once mark-sent said yes; a gate
 * refusal closes that tab and shows the reason.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { openWhatsAppMarkingSent, markSentBeforeShare } from "./share-marking-sent";
import SendWhatsAppDialog from "@/components/features/whatsapp/send-whatsapp-dialog";

const WA = "https://web.whatsapp.com/send?phone=919876543210&text=Hello%20Q-1";
const GATE_409 = "Needs approval first — Discount is 20% — over the 10% that goes out automatically. Ask a manager to approve it.";

const okMarkSent = () => new Response(
  JSON.stringify({ quoteStatus: "sent", changed: true, leadMoved: true, leadReason: null }), { status: 200 },
);

/** A fake tab the way window.open("about:blank") returns one. */
function fakeTab(order: string[]) {
  const tab = {
    opener: {} as unknown,
    closed: false,
    close: vi.fn(() => { order.push("close tab"); tab.closed = true; }),
    location: {
      _href: "about:blank",
      get href() { return this._href; },
      set href(v: string) { order.push(`tab → ${v}`); this._href = v; },
    },
  };
  return tab;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("R-1961: Send on WhatsApp (free share) on a draft", () => {
  it("opens a blank tab in the click, marks the draft sent, THEN points the tab at WhatsApp", async () => {
    const order: string[] = [];
    const tab = fakeTab(order);
    vi.spyOn(window, "open").mockImplementation(((url?: string | URL) => {
      order.push(`open ${String(url)}`);
      return tab as unknown as Window;
    }) as typeof window.open);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      order.push(`${init?.method ?? "GET"} ${url}`);
      return okMarkSent();
    }));
    const onMarkedSent = vi.fn();

    const r = await openWhatsAppMarkingSent({ quoteId: "Q-1", quoteStatus: "draft", url: WA, onMarkedSent });

    expect(order).toEqual(["open about:blank", "POST /api/quotes/Q-1/mark-sent", `tab → ${WA}`]);
    expect(r).toEqual({ refused: false, opened: true, markedSent: true });
    expect(onMarkedSent).toHaveBeenCalledTimes(1);
    // The WhatsApp tab gets no handle back to the app (what "noopener" gave the old direct open).
    expect(tab.opener).toBeNull();
  });

  it("the approval gate refuses (409): the blank tab is closed and the gate's reason is shown", async () => {
    const order: string[] = [];
    const tab = fakeTab(order);
    vi.spyOn(window, "open").mockImplementation((() => tab as unknown as Window) as typeof window.open);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: GATE_409 }), { status: 409 })));
    render(<Toaster />);
    const onMarkedSent = vi.fn();

    const r = await openWhatsAppMarkingSent({ quoteId: "Q-1", quoteStatus: "draft", url: WA, onMarkedSent });

    expect(r).toEqual({ refused: true, opened: false, markedSent: false });
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(order).not.toContain(`tab → ${WA}`);
    expect(onMarkedSent).not.toHaveBeenCalled();
    expect(await screen.findByText("WhatsApp not opened — the quote is still a draft")).toBeTruthy();
    expect(screen.getByText(/Needs approval first — Discount is 20%/)).toBeTruthy();
  });

  it("an already-sent quote opens WhatsApp directly — no mark-sent call, no blank tab", async () => {
    const opened: unknown[][] = [];
    vi.spyOn(window, "open").mockImplementation(((...a: unknown[]) => { opened.push(a); return null; }) as typeof window.open);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const r = await openWhatsAppMarkingSent({ quoteId: "Q-1", quoteStatus: "sent", url: WA });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(opened).toEqual([[WA, "_blank", "noopener,noreferrer"]]);
    expect(r).toEqual({ refused: false, opened: true, markedSent: false });
  });
});

describe("R-1961: the WhatsApp dialog (Cloud API) on a draft", () => {
  function renderDialog(beforeSend?: () => Promise<boolean>) {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Toaster />
        <SendWhatsAppDialog
          open onOpenChange={() => {}}
          defaultTo="+919876543210" defaultText={`Hi, accept here: ${WA}`}
          related={{ quoteId: "Q-1" }}
          beforeSend={beforeSend}
        />
      </QueryClientProvider>,
    );
  }

  it("marks the draft sent BEFORE the message (with the link) goes out", async () => {
    const order: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      order.push(`${init?.method ?? "GET"} ${url}`);
      return url.includes("mark-sent")
        ? okMarkSent()
        : new Response(JSON.stringify({ ok: true, wamid: "w1", status: "sent" }), { status: 200 });
    }));
    renderDialog(async () => (await markSentBeforeShare({ quoteId: "Q-1", quoteStatus: "draft", channel: "whatsapp-dialog" })).ok);

    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    await waitFor(() => expect(order).toEqual(["POST /api/quotes/Q-1/mark-sent", "POST /api/whatsapp/send"]));
  });

  it("the gate refuses: nothing is sent and the reason is shown", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ error: GATE_409 }), { status: 409 });
    }));
    renderDialog(async () => (await markSentBeforeShare({ quoteId: "Q-1", quoteStatus: "draft", channel: "whatsapp-dialog" })).ok);

    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));

    expect(await screen.findByText("WhatsApp not sent — the quote is still a draft")).toBeTruthy();
    expect(screen.getByText(/Needs approval first — Discount is 20%/)).toBeTruthy();
    expect(urls).toEqual(["/api/quotes/Q-1/mark-sent"]);
  });
});

describe("R-1961 wiring: every way the quote page shares the accept link goes through the one helper", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const PAGE = strip(readFileSync(join(process.cwd(), "src", "app", "(app)", "quotes", "[id]", "page.tsx"), "utf8"));
  const TOAST = strip(readFileSync(join(process.cwd(), "src", "components", "features", "quotes", "failed-send-toast.ts"), "utf8"));

  it("Send on WhatsApp uses openWhatsAppMarkingSent — no direct window.open of the WhatsApp link", () => {
    const share = PAGE.slice(PAGE.indexOf("const shareQuoteOnWhatsApp"), PAGE.indexOf("const daysLeft"));
    expect(share).toContain("openWhatsAppMarkingSent(");
    expect(share).not.toMatch(/window\.open\(\s*link/);
  });

  it("the WhatsApp dialog is given a beforeSend that marks the draft sent", () => {
    const dialog = PAGE.slice(PAGE.indexOf("<SendWhatsAppDialog"));
    expect(dialog).toMatch(/beforeSend=\{[\s\S]*?markSentBeforeShare\(/);
  });

  it("Copy link uses the same helper", () => {
    expect(TOAST).toContain("markSentBeforeShare(");
  });
});
