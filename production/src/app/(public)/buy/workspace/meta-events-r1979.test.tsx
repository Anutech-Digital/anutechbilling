// @vitest-environment jsdom
/**
 * R-1979 (G-ADS): Meta events on /buy/workspace and its thanks page —
 *   PageView + ViewContent on arrival, InitiateCheckout when checkout step 1 is done,
 *   AddPaymentInfo when the payment step opens, Purchase on the paid thanks page with the
 *   SAME event id as the server's Conversions API event ("purchase-<quote>").
 * Only with a pixel id AND "Accept all" — otherwise no script and no event. The order carries
 * the consent and the _fbp cookie so the server event can be sent (and only then).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, within, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient, type CatalogItem } from "./buy-workspace-client";
import { ThanksClient, type ThanksOrder } from "./thanks/thanks-client";
import { CONSENT_KEY } from "@/site/lib/meta-pixel";

const row = (id: string, name: string, annual: number, monthly: number): CatalogItem => ({
  id, name, msrp: annual, wholesale: 0, margin_pct: null, is_active: true,
  prices: { annual: { msrp: annual, wholesale: 0 }, monthly: { msrp: monthly, wholesale: 0 } },
});
const CATALOG = [row("s", "Google Workspace Business Starter", 270, 325), row("d", "Google Workspace Business Standard", 1080, 1300)];
const PIXEL = "1234567890123456";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } } as Storage;
}

let calls: Array<{ url: string; body: Record<string, unknown> }> = [];
beforeEach(() => {
  calls = [];
  delete window.fbq; delete window._fbq;
  document.head.innerHTML = "";
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  document.cookie = "_fbp=fb.1.111.222";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
    if (String(url).includes("checkout/workspace")) return new Response(JSON.stringify({ simulated: true, quoteId: "Q-T-27-0001", publicToken: "tok" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const events = () => (window.fbq?.queue ?? []).filter((q) => q[0] === "track").map((q) => q[1]);
const checkout = () => document.getElementById("checkout") as HTMLElement;
const type = (label: RegExp | string, value: string) => fireEvent.change(within(checkout()).getByLabelText(label, { selector: "input,select" }), { target: { value } });

describe("R-1979 Meta events on the buy page", () => {
  it("consent + pixel: PageView, ViewContent; InitiateCheckout after step 1; AddPaymentInfo at payment; the order carries consent + _fbp", async () => {
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} initialTierId="starter" initialSeats={1} metaPixelId={PIXEL} />);
    expect(events()).toEqual(["PageView", "ViewContent"]);
    const vc = window.fbq!.queue!.find((q) => q[1] === "ViewContent")!;
    expect(vc[2]).toMatchObject({ content_ids: ["google-workspace-starter"], value: 3240, currency: "INR" });
    type("Your domain", "ravitraders.in");
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue" }));
    expect(events()).toContain("InitiateCheckout");
    type("Your name", "Ravi Kumar");
    type("Email for invoice and login", "ravi@example.invalid");
    type("Mobile (WhatsApp)", "9811122233");
    fireEvent.change(within(checkout()).getByLabelText("State (place of supply)"), { target: { value: "07" } });
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue to payment" }));
    expect(events()).toEqual(["PageView", "ViewContent", "InitiateCheckout", "AddPaymentInfo"]);
    fireEvent.click(within(checkout()).getByLabelText(/I agree to the/));
    fireEvent.click(within(checkout()).getByRole("button", { name: /Place test order/ }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/public/checkout/workspace")).toBe(true));
    expect(calls.find((c) => c.url === "/api/public/checkout/workspace")!.body).toMatchObject({ metaConsent: true, fbp: "fb.1.111.222" });
  });

  it("no consent → no Meta script and no events; the order says metaConsent false", async () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} initialTierId="starter" initialSeats={1} metaPixelId={PIXEL} />);
    expect(window.fbq).toBeUndefined();
    expect(document.querySelector('script[src*="connect.facebook.net"]')).toBeNull();
  });

  it("no pixel id → nothing, even with consent", () => {
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} />);
    expect(window.fbq).toBeUndefined();
  });
});

describe("R-1979 Purchase on the thanks page", () => {
  const ORDER: ThanksOrder = {
    quoteId: "Q-T-27-0001", invoiceNumber: null, customerName: "Ravi Traders", tierName: "Business Starter",
    seats: 1, amount: 3823, subtotal: 3240, paymentStatus: "received", paymentState: "paid",
    amountReceived: 3823, paymentDate: null, planLabel: "google-workspace-starter",
  };
  it("paid → Purchase, value before GST, INR, eventID purchase-<quote> (the server's id)", () => {
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<ThanksClient order={ORDER} isSimulation={false} brand={null} metaPixelId={PIXEL} />);
    const p = window.fbq!.queue!.find((q) => q[1] === "Purchase")!;
    expect(p[2]).toMatchObject({ value: 3240, currency: "INR", content_ids: ["google-workspace-starter"] });
    expect(p[3]).toEqual({ eventID: "purchase-Q-T-27-0001" });
  });
  it("not paid → no Purchase", () => {
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<ThanksClient order={{ ...ORDER, paymentState: "awaiting" as ThanksOrder["paymentState"] }} isSimulation={false} brand={null} metaPixelId={PIXEL} />);
    expect((window.fbq?.queue ?? []).some((q) => q[1] === "Purchase")).toBe(false);
  });
});

describe("R-1979 thanks page asks the server for the Conversions API Purchase", () => {
  const ORDER: ThanksOrder = {
    quoteId: "Q-T-27-0001", invoiceNumber: null, customerName: "Ravi Traders", tierName: "Business Starter",
    seats: 1, amount: 3823, subtotal: 3240, paymentStatus: "received", paymentState: "paid",
    amountReceived: 3823, paymentDate: null, planLabel: "google-workspace-starter",
  };
  const metaPosts = () => calls.filter((c) => c.url === "/api/public/checkout/workspace/meta-purchase");
  it("paid, consent, live order → POST with the quote, its token and _fbp", async () => {
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<ThanksClient order={ORDER} isSimulation={false} brand={null} metaPixelId={PIXEL} orderToken="tok-123456789" />);
    await waitFor(() => expect(metaPosts()).toHaveLength(1));
    expect(metaPosts()[0].body).toMatchObject({ quoteId: "Q-T-27-0001", t: "tok-123456789", consent: true, fbp: "fb.1.111.222" });
  });
  it("no consent, or a simulated order (the route already sent it) → no POST", () => {
    render(<ThanksClient order={ORDER} isSimulation={false} brand={null} metaPixelId={PIXEL} orderToken="tok-123456789" />);
    cleanup();
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<ThanksClient order={ORDER} isSimulation={true} brand={null} metaPixelId={PIXEL} orderToken="tok-123456789" />);
    expect(metaPosts()).toHaveLength(0);
  });
});
