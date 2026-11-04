// @vitest-environment jsdom
/**
 * R-1931 (G-ONBOARD OB-10): the Dashboard shows ONE onboarding list — "Get to your first
 * quote" — with a button on every open item, ticks from real data, gone when all done.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import * as fs from "node:fs";
import * as path from "node:path";
import { GettingStartedCard, FirstQuoteRows } from "./getting-started-card";
import type { FirstQuoteFacts } from "./setup-checklist";

/* R-253: the card reads the signed-in role to leave out steps on pages that role cannot open. */
let mockRole: string | null = "owner";
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: mockRole ? { role: mockRole } : undefined }),
}));

afterEach(() => { cleanup(); mockRole = "owner"; });

const VALID_GSTIN = "07ABDCA0298H1ZP";

const fresh: FirstQuoteFacts = {
  address: null, stateCode: null, gstin: null, gstRegistration: null,
  productCount: 0, quoteCount: 0, sentQuoteCount: 0, draftQuoteId: null,
  customerMessages: "off",
  upiVpa: null, remitAccountNumber: null, remitIfsc: null,
  memberCount: 1, pendingInvites: 0,
};
/** The E2E-like company: many customers, products, quotes sent, messages on, a team. */
const trading: FirstQuoteFacts = {
  address: "12 Nehru Place", stateCode: "07", gstin: VALID_GSTIN, gstRegistration: "registered",
  productCount: 15, quoteCount: 42, sentQuoteCount: 30, draftQuoteId: "q-draft",
  customerMessages: "on",
  upiVpa: "shop@okhdfcbank", remitAccountNumber: null, remitIfsc: null,
  memberCount: 4, pendingInvites: 0,
};

const LABELS = [
  "Set your state and GSTIN", "Load your price list", "Create your first quote",
  "Send the quote link", "Turn on customer messages", "Add bank or UPI", "Invite your team",
];

const row = (label: string) => screen.getByText(label).closest("li") as HTMLElement;
const isTicked = (label: string) => within(row(label)).queryByLabelText("Done") !== null;

describe("one list, every item has a button", () => {
  it("a new company sees the 7 items in order, under 'Get to your first quote'", () => {
    render(<GettingStartedCard facts={fresh} />);
    expect(screen.getByRole("heading", { name: /Get to your first quote/ })).toBeDefined();
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(items).toHaveLength(7);
    LABELS.forEach((l, i) => expect(items[i]).toContain(l));
    for (const l of LABELS) expect(isTicked(l), l).toBe(false);
  });

  it("every open item has its own button to the right place", () => {
    render(<GettingStartedCard facts={fresh} />);
    const href = (label: string) => within(row(label)).getByRole("link").getAttribute("href");
    expect(href("Set your state and GSTIN")).toBe("/settings?tab=company#settings-registered-state");
    expect(href("Load your price list")).toBe("/items");
    expect(href("Create your first quote")).toBe("/quotes/new");
    expect(href("Send the quote link")).toBe("/quotes");
    expect(href("Turn on customer messages")).toBe("/automation#customer-messages");
    expect(href("Add bank or UPI")).toBe("/settings?tab=company#payment-details");
    expect(href("Invite your team")).toBe("/team");
  });

  it("only the next step is the primary button (one primary per view)", () => {
    render(<GettingStartedCard facts={{ ...fresh, stateCode: "07", address: "x", gstin: VALID_GSTIN }} />);
    const primaries = screen.getAllByRole("link").filter((a) => a.className.includes("bg-amber "));
    expect(primaries).toHaveLength(1);
    expect(primaries[0].textContent).toBe("Load catalog");
  });

  it("the old lists are gone: no customer step, no 'Before you bill', no numbering/email rows", () => {
    render(<GettingStartedCard facts={fresh} />);
    expect(screen.queryByText("Add your first customer")).toBeNull();
    expect(screen.queryByText("Before you bill")).toBeNull();
    expect(screen.queryByText("Set invoice numbering")).toBeNull();
    expect(screen.queryByText("Set up sending email")).toBeNull();
    expect(screen.queryByText("Record your first payment")).toBeNull();
  });
});

describe("ticks from real data", () => {
  it("a company with products and quotes, none sent: first three ticked, Send link next", () => {
    render(<GettingStartedCard facts={{ ...fresh, stateCode: "07", address: "x", gstin: VALID_GSTIN, productCount: 7, quoteCount: 2, draftQuoteId: "q1" }} />);
    expect(isTicked("Set your state and GSTIN")).toBe(true);
    expect(isTicked("Load your price list")).toBe(true);
    expect(isTicked("Create your first quote")).toBe(true);
    expect(isTicked("Send the quote link")).toBe(false);
    expect(within(row("Send the quote link")).getByRole("link").getAttribute("href")).toBe("/quotes/q1");
    expect(screen.getByText(/3 of 7 done/)).toBeDefined();
  });

  it("the trading (E2E-like) company: everything done → the card is gone", () => {
    const { container } = render(<GettingStartedCard facts={trading} />);
    expect(container.innerHTML).toBe("");
  });

  it("stays while one item is open (messages off)", () => {
    render(<GettingStartedCard facts={{ ...trading, customerMessages: "off" }} />);
    expect(isTicked("Turn on customer messages")).toBe(false);
    expect(screen.getByText(/6 of 7 done/)).toBeDefined();
  });

  it("renders nothing while a fact is still loading", () => {
    const { container } = render(<GettingStartedCard facts={{ ...fresh, quoteCount: undefined }} />);
    expect(container.innerHTML).toBe("");
  });

  it("keeps the #setup-checklist anchor other screens link to", () => {
    const { container } = render(<GettingStartedCard facts={fresh} />);
    expect(container.querySelector("#setup-checklist")).not.toBeNull();
  });
});

describe("roles", () => {
  it("manager: no owner-only rows, a note to ask the owner", () => {
    mockRole = "manager";
    render(<GettingStartedCard facts={fresh} />);
    expect(screen.queryByText("Set your state and GSTIN")).toBeNull();
    expect(screen.queryByText("Turn on customer messages")).toBeNull();
    expect(screen.getByText("Create your first quote")).toBeDefined();
    expect(screen.getByText(/Only the owner can finish/)).toBeDefined();
  });

  it("billing (cannot open /quotes or /items): no button that bounces it away", () => {
    mockRole = "billing";
    const { container } = render(<GettingStartedCard facts={fresh} />);
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/quotes") || h.startsWith("/items") || h.startsWith("/settings"))).toBe(false);
  });

  it("a one-time business is sent to the One-time products tab (R-1862)", () => {
    render(<GettingStartedCard facts={fresh} sellMode="one_time" />);
    expect(within(row("Add your first one-time item")).getByRole("link").getAttribute("href")).toBe("/items/products");
  });
});

describe("the /setup Done screen reuses the same list", () => {
  it("FirstQuoteRows renders the same 7 items", () => {
    render(<FirstQuoteRows facts={fresh} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });

  it("done-screen.tsx uses FirstQuoteRows + useFirstQuoteFacts and no longer builds its own GSTIN / payout / customers rows", () => {
    const done = fs.readFileSync(path.join(__dirname, "../../../app/(app)/setup/done-screen.tsx"), "utf8");
    expect(done).toMatch(/<FirstQuoteRows\b/);
    expect(done).toMatch(/useFirstQuoteFacts\(\)/);
    expect(done).not.toMatch(/customerCount|catalogCount|useCustomers/);
  });

  it("the dashboard mounts the one card from the same facts hook", () => {
    const page = fs.readFileSync(path.join(__dirname, "../../../app/(app)/dashboard/page.tsx"), "utf8");
    expect(page).toMatch(/useFirstQuoteFacts\(\)/);
    expect(page).toMatch(/<GettingStartedCard\b/);
    expect(page).not.toMatch(/hasCustomer=|useSetupFacts/);
  });
});
