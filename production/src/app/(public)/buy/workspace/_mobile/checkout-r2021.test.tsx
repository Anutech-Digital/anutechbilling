// @vitest-environment jsdom
/**
 * R-2021 (R-2019b, Pardeep 27 Oct 2026): the phone checkout — Domain → Details → Review & pay →
 * Processing → Success / Failed — as the owner walks it on a 375px phone (?view=mobile):
 * Standard, 10 licences, yearly → Continue → his own domain → name, mobile, email, GSTIN → Review
 * → Pay. What the card asks to be PROVEN:
 *   - GSTIN validation (format + checksum) with errors only after Continue and one summary line;
 *   - the consent gate: no draft lead on our server unless "WhatsApp me a link …" is ticked
 *     (unticked by default); without it the details stay on the phone only;
 *   - the totals shown = the server's amount: Razorpay opens with the amount the route sent, and a
 *     different server amount is shown to the buyer before any payment window opens;
 *   - a refresh keeps the step and what was typed;
 *   - the desktop tree is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { BuyMobileClient } from "./buy-mobile-client";
import {
  EMPTY_FORM, FORM_KEY, detailsErrors, errorSummary, gstinError, mobileCheckoutBody, firstIncompleteStep, type MobileForm,
} from "./form-state";
import { DRAFT_SENT_KEY } from "./checkout-flow";
import { serverAmountDiffers } from "./pay";
import { checkoutBody, EMPTY_BUYER, EMPTY_DOMAIN } from "../_parts/checkout-form";
import type { CatalogItem } from "../_parts/tiers";
import type { BuyBrand } from "../_parts/brand";
import type { BuyPlan } from "../_parts/plans";

const row = (id: string, name: string, annual: number, monthly: number): CatalogItem => ({
  id, name, msrp: annual, wholesale: 0, margin_pct: null, is_active: true,
  prices: { annual: { msrp: annual, wholesale: 0 }, monthly: { msrp: monthly, wholesale: 0 } },
});
const CATALOG: CatalogItem[] = [
  row("s", "Google Workspace Business Starter", 270, 325),
  row("d", "Google Workspace Business Standard", 1080, 1300),
];
const BRAND: BuyBrand = {
  name: "Tenant Seller Pvt Ltd", logoUrl: null, gstin: "07AAAAA0000A1Z5",
  address: "12 Test Road, Rohini, Delhi 110085", stateCode: "07", phone: null, email: null,
};
/** A real, checksum-valid GSTIN (Maharashtra). */
const GOOD_GSTIN = "27AAPFU0939F1ZV";
/** 10 × ₹1,080 × 12 = ₹1,29,600 + ₹23,328 GST. */
const TOTAL = 152928;
const TOTAL_TXT = "₹1,52,928";

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
let checkoutReply: Record<string, unknown> = {};
const mem = new Map<string, string>();
const sess = new Map<string, string>();
const rzp: { opts: Record<string, unknown>[]; opened: number } = { opts: [], opened: 0 };

beforeEach(() => {
  calls = [];
  mem.clear(); sess.clear();
  rzp.opts = []; rzp.opened = 0;
  checkoutReply = { success: true, orderId: "order_T1", amount: TOTAL * 100, currency: "INR", razorpayKeyId: "rzp_test_x", quoteId: "Q-T-0001", publicToken: "tok", tierName: "Business Standard", seats: 10, totalRupees: TOTAL };
  const store = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 });
  Object.defineProperty(window, "localStorage", { value: store(mem), configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: store(sess), configurable: true });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url.startsWith("/api/public/site-promo")) return new Response(JSON.stringify({ promo: null }), { status: 200 });
    if (url === "/api/public/checkout/workspace") return new Response(JSON.stringify(checkoutReply), { status: 200 });
    if (url === "/api/public/enquiry/workspace/draft") return new Response(JSON.stringify({ success: true, leadId: "L-DRAFT" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }));
  (window as unknown as { Razorpay: unknown }).Razorpay = class {
    constructor(o: Record<string, unknown>) { rzp.opts.push(o); }
    on() { /* payment.failed */ }
    open() { rzp.opened++; }
  };
  window.history.replaceState(null, "", "/buy/workspace?utm_source=facebook&fbclid=Ad1");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const phone = (search: Record<string, string>, paymentMode: "live" | "simulation" | "disabled" = "simulation") =>
  render(<BuyMobileClient catalogItems={CATALOG} paymentMode={paymentMode} brand={BRAND} initialSearch={search} />);
const PLAN = { intent: "new", tier: "standard", seats: "10", billing: "annual" };
const typeIn = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const stepTitle = () => screen.getByTestId("step-title").textContent;
const urlStep = () => new URLSearchParams(window.location.search).get("step");

async function toDetails() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByTestId("step-title");
  typeIn("Your domain", "ravitraders.in");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(stepTitle()).toBe("Step 2 of 3 · Your details"));
}
function fillDetails(gstin = GOOD_GSTIN) {
  typeIn("Your name", "Ravi Kumar");
  typeIn("Mobile number", "98765 43210");
  typeIn("Email for the invoice", "ravi@example.invalid");
  fireEvent.click(screen.getByRole("radio", { name: "Yes, add GSTIN" }));
  typeIn("GSTIN", gstin);
  typeIn("Business name (as on GST certificate)", "Ravi Traders");
}
const FILLED: MobileForm = {
  ...EMPTY_FORM, domainMode: "have", domain: "ravitraders.in", name: "Ravi Kumar", phone: "9876543210",
  email: "ravi@example.invalid", needGst: true, gstin: GOOD_GSTIN, company: "Ravi Traders",
};

describe("R-2021: GSTIN validation (as the server: 15 characters + checksum)", () => {
  it("blank / short / wrong checksum are refused with a plain message; a real GSTIN passes and gives the state", () => {
    expect(gstinError("")).toBe("Please add your 15-character GSTIN");
    expect(gstinError("27AAPFU")).toBe("8 more characters — a GSTIN has 15");
    expect(gstinError("07ABCDE1234F1Z5")).not.toBe(""); // looks right, checksum wrong
    expect(gstinError(GOOD_GSTIN)).toBe("");
    expect(gstinError(" 27aapfu0939f1zv ")).toBe("");
    const e = detailsErrors({ ...FILLED, gstin: "07ABCDE1234F1Z5" }, false);
    expect(Object.keys(e)).toEqual(["gstin"]);
    expect(errorSummary(e)).toBe("Please add a valid GSTIN.");
    expect(mobileCheckoutBody({ plan: { id: "standard" } as BuyPlan, seats: 10, billing: "annual", intent: "new", form: FILLED, couponCode: null, simulate: true }))
      .toMatchObject({ gstin: GOOD_GSTIN, stateCode: "27", phone: "+919876543210", companyName: "Ravi Traders" });
  });

  it("GST 'No' asks for the state instead (the invoice needs a place of supply); a GSTIN is never sent", () => {
    const e = detailsErrors({ ...FILLED, needGst: false, gstin: "", company: "" }, false);
    expect(e).toEqual({ stateCode: "Please choose your state — it decides the GST on your invoice" });
    const body = mobileCheckoutBody({ plan: { id: "standard" } as BuyPlan, seats: 10, billing: "annual", intent: "new", form: { ...FILLED, needGst: false, gstin: GOOD_GSTIN, stateCode: "07" }, couponCode: null, simulate: true });
    expect(body.gstin).toBeUndefined();
    expect(body.stateCode).toBe("07");
  });

  it("on the phone: errors appear only after Continue, with one summary line on top, and the step stays", async () => {
    phone(PLAN);
    await toDetails();
    expect(screen.queryByTestId("details-summary")).toBeNull();
    fillDetails("07ABCDE1234F1Z5");
    expect(screen.queryByTestId("details-summary")).toBeNull(); // typing never shouts
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("details-summary").textContent).toBe("Please add a valid GSTIN.");
    expect(screen.getByLabelText("GSTIN").getAttribute("aria-invalid")).toBe("true");
    expect(urlStep()).toBe("details");
    typeIn("GSTIN", GOOD_GSTIN);
    expect(screen.getByText("✓ Valid · Maharashtra")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(urlStep()).toBe("review"));
  });

  it("mobile field: numeric keypad, +91 prefix, autocomplete on every field", async () => {
    phone(PLAN);
    await toDetails();
    const m = screen.getByLabelText("Mobile number");
    expect([m.getAttribute("inputmode"), m.getAttribute("type"), m.getAttribute("autocomplete")]).toEqual(["numeric", "tel", "tel-national"]);
    expect(screen.getByText("+91")).toBeTruthy();
    expect(screen.getByLabelText("Your name").getAttribute("autocomplete")).toBe("name");
    expect(screen.getByLabelText("Email for the invoice").getAttribute("autocomplete")).toBe("email");
  });
});

describe("R-2021: consent gate — no draft lead without the WhatsApp tick (G-DPDP)", () => {
  it("the box is separate and UNTICKED; Continue without it sends nothing — the details stay on this phone", async () => {
    phone(PLAN);
    await toDetails();
    const box = screen.getByRole("checkbox", { name: /WhatsApp me a link to finish this order/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByTestId("data-notice")).toBeTruthy(); // the R-2011 notice, one place
    expect((screen.getByRole("checkbox", { name: /Send me offers/ }) as HTMLInputElement).checked).toBe(false);
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(urlStep()).toBe("review"));
    expect(calls.filter((c) => c.url.includes("/draft"))).toEqual([]);
    expect(calls.filter((c) => c.url.startsWith("/api/public/") && !c.url.includes("site-promo"))).toEqual([]);
    expect(JSON.parse(mem.get(FORM_KEY) ?? "{}").form.name).toBe("Ravi Kumar"); // only here
  });

  it("ticked → ONE draft lead with resumeConsent true (and the plan, intent, domain mode); never twice in a visit", async () => {
    phone(PLAN);
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("checkbox", { name: /WhatsApp me a link to finish this order/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/draft")).length).toBe(1));
    const d = calls.find((c) => c.url.includes("/draft"))!.body;
    expect(d).toMatchObject({ resumeConsent: true, fullName: "Ravi Kumar", phone: "+919876543210", tierId: "standard", seats: 10, billing: "annual", intent: "new", domainMode: "have", domain: "ravitraders.in" });
    await waitFor(() => expect(sess.get(DRAFT_SENT_KEY)).toBe("L-DRAFT"));
    fireEvent.click(screen.getByRole("button", { name: /Change Your details/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /WhatsApp me a link to finish this order/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(urlStep()).toBe("review"));
    expect(calls.filter((c) => c.url.includes("/draft")).length).toBe(1);
  });
});

describe("R-2021: the total shown is the server's amount", () => {
  it("summary, bar, breakdown and Pay show ONE total; Razorpay opens with exactly the amount the route sent", async () => {
    phone(PLAN, "live");
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(stepTitle()).toBe("Step 3 of 3 · Review & pay"));
    expect(screen.getByTestId("summary-total").textContent).toBe(TOTAL_TXT);
    expect(screen.getByTestId("bar-total").textContent).toBe(TOTAL_TXT);
    expect(screen.getByTestId("breakdown-total").textContent).toBe(TOTAL_TXT);
    const pay = screen.getByRole("button", { name: `Pay ${TOTAL_TXT} securely` });
    fireEvent.click(pay);
    expect(screen.getByRole("alert").textContent).toMatch(/Tick the box to agree/); // R-226: no window without the tick
    expect(calls.some((c) => c.url === "/api/public/checkout/workspace")).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree to the/ }));
    await act(async () => { fireEvent.click(pay); });
    await waitFor(() => expect(rzp.opened).toBe(1));
    expect(rzp.opts[0]).toMatchObject({ amount: TOTAL * 100, order_id: "order_T1", key: "rzp_test_x", name: "Tenant Seller Pvt Ltd" });
    const sent = calls.find((c) => c.url === "/api/public/checkout/workspace")!.body;
    expect(sent).toMatchObject({ tierId: "standard", seats: 10, commitment: "annual", domain: "ravitraders.in", intent: "new", domainMode: "have", migrationSource: "none", simulate: false });
    expect(JSON.stringify(sent)).not.toMatch(/"(amount|total|price|rate)"/); // the phone never sends a charge
  });

  it("the server's amount differs → the buyer sees the SERVER's amount first; Razorpay opens only on their yes, with that amount", async () => {
    checkoutReply = { ...checkoutReply, amount: 160000 * 100, totalRupees: 160000 };
    phone(PLAN, "live");
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Check everything once");
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree to the/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `Pay ${TOTAL_TXT} securely` })); });
    await screen.findByText("The price for your order is ₹1,60,000");
    expect(rzp.opened).toBe(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pay ₹1,60,000 securely" })); });
    await waitFor(() => expect(rzp.opened).toBe(1));
    expect(rzp.opts[0].amount).toBe(160000 * 100);
    expect(serverAmountDiffers({ amountPaise: TOTAL * 100 } as never, TOTAL)).toBe(false);
  });

  it("Failed keeps the order: Try again reopens Razorpay for the SAME server order (no second order)", async () => {
    phone(PLAN, "live");
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Check everything once");
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree to the/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `Pay ${TOTAL_TXT} securely` })); });
    await waitFor(() => expect(rzp.opened).toBe(1));
    const modal = rzp.opts[0].modal as { ondismiss: () => void };
    act(() => modal.ondismiss());
    expect(screen.getByText("Payment not finished")).toBeTruthy();
    expect(screen.getByText(/Q-T-0001/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pay another way" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Talk to us" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `Try again · ${TOTAL_TXT}` })); });
    await waitFor(() => expect(rzp.opened).toBe(2));
    expect(rzp.opts[1].order_id).toBe("order_T1");
    expect(calls.filter((c) => c.url === "/api/public/checkout/workspace").length).toBe(1);
  });

  it("simulation: 'Place test order' → the server's order → the existing thanks page (Success)", async () => {
    checkoutReply = { success: true, simulated: true, quoteId: "Q-T-0002", publicToken: "tok2", totalRupees: TOTAL };
    phone(PLAN, "simulation");
    await toDetails();
    fillDetails();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Check everything once");
    fireEvent.click(screen.getByRole("checkbox", { name: /I agree to the/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `Place test order · ${TOTAL_TXT}` })); });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/public/checkout/workspace")).toBe(true));
    expect(calls.find((c) => c.url === "/api/public/checkout/workspace")!.body.simulate).toBe(true);
    expect(mem.get(FORM_KEY)).toBeUndefined(); // the phone's copy is cleared once ordered
  });

  it("payment off (disabled): no Pay button — the quote callback instead", async () => {
    mem.set(FORM_KEY, JSON.stringify({ at: Date.now(), form: FILLED }));
    phone({ ...PLAN, step: "review" }, "disabled");
    await screen.findByText("Check everything once");
    expect(screen.queryByRole("button", { name: /Pay|Place test order/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Get a GST quote" }));
    expect(screen.getByRole("dialog", { name: "Get a quote by phone" })).toBeTruthy();
    expect((screen.getByLabelText("Your name", { selector: "#ls-name" }) as HTMLInputElement).value).toBe("Ravi Kumar");
  });
});

describe("R-2021: refresh keeps the step and what was typed", () => {
  it("step in the URL + the form in this phone's storage → Review comes back filled; ad params kept", async () => {
    mem.set(FORM_KEY, JSON.stringify({ at: Date.now(), form: FILLED }));
    window.history.replaceState(null, "", "/buy/workspace?utm_source=facebook&fbclid=Ad1&step=review&intent=new&tier=standard&seats=10&billing=annual");
    phone({ ...PLAN, step: "review", utm_source: "facebook", fbclid: "Ad1" });
    await screen.findByText("Check everything once");
    expect(stepTitle()).toBe("Step 3 of 3 · Review & pay");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
    expect(screen.getByText("Ravi Kumar · +91 9876543210 · ravi@example.invalid")).toBeTruthy();
    expect(screen.getByText("ravitraders.in")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("fbclid")).toBe("Ad1");
  });

  it("Details refresh: every field comes back", async () => {
    mem.set(FORM_KEY, JSON.stringify({ at: Date.now(), form: FILLED }));
    phone({ ...PLAN, step: "details" });
    await waitFor(() => expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Ravi Kumar"));
    expect((screen.getByLabelText("GSTIN") as HTMLInputElement).value).toBe(GOOD_GSTIN);
    expect(stepTitle()).toBe("Step 2 of 3 · Your details");
  });

  it("a later step with something missing (new phone, cleared storage) lands on the first step that needs it", async () => {
    phone({ ...PLAN, step: "review" });
    await waitFor(() => expect(urlStep()).toBe("domain"));
    expect(stepTitle()).toBe("Step 1 of 3 · Email address");
    expect(firstIncompleteStep(FILLED, "new")).toBeNull();
    expect(firstIncompleteStep({ ...FILLED, email: "" }, "new")).toBe("details");
  });

  it("every checkout screen: back arrow, Step n of 3, progress bar, collapsible price summary, Talk to us", async () => {
    phone(PLAN);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByTestId("step-title");
    expect(stepTitle()).toBe("Step 1 of 3 · Email address");
    const sum = screen.getByRole("button", { name: /Standard · 10 licences · Yearly/ });
    expect(sum.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(sum);
    expect(within(document.getElementById("m-price-summary")!).getByText("₹1,080 × 10 licences × 12 months")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Talk to us" }));
    expect(screen.getByRole("dialog", { name: "Talk to us" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("What do you need?")).toBeTruthy();
  });

  it("a switch (transfer) asks only for the domain on Google Workspace now; Decide later needs no domain", async () => {
    phone({ ...PLAN, intent: "transfer" });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Which domain is on Google Workspace now?");
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual([expect.stringContaining("I'm already on Google Workspace")]);
    cleanup();
    phone(PLAN);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("What should your email address be?");
    fireEvent.click(screen.getByRole("radio", { name: /Decide later/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(urlStep()).toBe("details"));
  });
});

describe("R-2021: the desktop tree is unchanged", () => {
  it("page.tsx still sends a laptop the v2 client; the desktop never imports the phone files", () => {
    const page = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
    expect(page).toMatch(/if \(view === "mobile"\)[\s\S]{0,400}return \(\s*<BuyMobileClient/);
    expect(page).toMatch(/<BuyWorkspaceClient\s/);
    for (const f of ["buy-workspace-client.tsx", "_parts/checkout.tsx", "_parts/use-checkout.ts", "_parts/order-summary.tsx"]) {
      expect(readFileSync(join(__dirname, "..", f), "utf8"), f).not.toMatch(/from "[^"]*_mobile\//);
    }
  });

  it("the desktop's checkout body is the same as before — none of the phone's new fields", () => {
    const body = checkoutBody({ plan: { id: "standard" } as BuyPlan, seats: 10, billing: "annual", domain: { ...EMPTY_DOMAIN, domain: "acme.in" }, buyer: { ...EMPTY_BUYER, name: "A B", email: "a@b.in", phone: "9876543210", stateCode: "07" }, couponCode: null, simulate: true });
    expect(Object.keys(body).sort()).toEqual(["agreeTerms", "commitment", "companyName", "couponCode", "domain", "domainNew", "email", "fullName", "gstin", "phone", "seats", "simulate", "stateCode", "tierId"]);
  });
});
