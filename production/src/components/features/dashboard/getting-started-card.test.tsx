// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { GettingStartedCard } from "./getting-started-card";
import type { SetupFacts } from "./setup-checklist";

/* R-253: the card reads the signed-in role to leave out steps on pages that role cannot open. */
let mockRole: string | null = "owner";
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: mockRole ? { role: mockRole } : undefined }),
}));

afterEach(() => { cleanup(); mockRole = "owner"; });

/* A GSTIN that really passes the checksum — ANUTECH's own (CLAUDE.md §1).
   NOT the wizard's placeholder 27AABCE9876D1Z3: that one is fabricated and FAILS the checksum,
   which is exactly what this component refuses to tick. */
const VALID_GSTIN = "07ABDCA0298H1ZP";

/** A brand-new workspace: every fact loaded, nothing filled in. */
const freshSetup: SetupFacts = {
  address: null, stateCode: null, gstin: null,
  upiVpa: null, remitAccountNumber: null, remitIfsc: null,
  invoiceCode: { saved: null, locked: false },
  email: { provider: "resend", fromAddress: null, hasResendKey: false, canSendNow: true },
  memberCount: 1, pendingInvites: 0,
};
/** Everything "before you bill" finished. */
const doneSetup: SetupFacts = {
  address: "Plot 1, Delhi", stateCode: "07", gstin: VALID_GSTIN,
  upiVpa: "anutech@okhdfcbank", remitAccountNumber: null, remitIfsc: null,
  invoiceCode: { saved: "AD", locked: false },
  email: { provider: "gmail", canSendNow: true },
  memberCount: 2, pendingInvites: 0,
};

const props = {
  setup: freshSetup,
  hasCustomer: false,
  hasCatalog: false,
  hasQuote: false,
  hasSale: false,
  workspaceName: "ANUTECH DIGITAL PVT LTD",
};

/** The row for a step, found by its visible label. */
const row = (label: string) => screen.getByText(label).closest("li") as HTMLElement;
const isTicked = (label: string) => row(label).querySelector("svg") !== null;

const SETUP_LABELS = [
  "Add company address", "Add your GSTIN", "Set invoice numbering",
  "Add bank or UPI", "Set up sending email", "Invite your team",
];
const SALE_LABELS = [
  "Add your first customer", "Load your price list", "Create your first quote", "Record your first payment",
];

describe("the GST step is its own fact", () => {
  it("stays OPEN when the address is saved but there is no GSTIN", () => {
    /* GSTIN is optional in the setup wizard, so `setup_completed_at` gets stamped either way.
       The GST row must not ride on anything but the GSTIN itself. */
    render(<GettingStartedCard {...props} setup={{ ...freshSetup, address: "Plot 1", stateCode: "07" }} />);
    expect(isTicked("Add company address")).toBe(true);
    expect(isTicked("Add your GSTIN")).toBe(false);
  });

  it("ticks only once the GSTIN passes format AND checksum", () => {
    render(<GettingStartedCard {...props} setup={{ ...freshSetup, gstin: VALID_GSTIN }} />);
    expect(isTicked("Add your GSTIN")).toBe(true);
  });

  it("does not tick a GSTIN that is the right LENGTH but fails the checksum", () => {
    render(<GettingStartedCard {...props} setup={{ ...freshSetup, gstin: "07ABDCA0298H1ZQ" }} />);
    expect(isTicked("Add your GSTIN")).toBe(false);
  });

  it("tells the reseller WHY the GSTIN matters", () => {
    render(<GettingStartedCard {...props} />);
    expect(within(row("Add your GSTIN")).getByText(/valid tax invoice/i)).toBeDefined();
  });
});

describe("S31 — before you bill", () => {
  it("a brand-new workspace sees every setup step open, in one card", () => {
    render(<GettingStartedCard {...props} />);
    for (const label of [...SETUP_LABELS, ...SALE_LABELS]) {
      expect(isTicked(label), `${label} should start unticked`).toBe(false);
    }
    expect(screen.getByText("Before you bill")).toBeDefined();
    expect(screen.getByText(/6 left before you can bill/)).toBeDefined();
  });

  it("each setup row links straight to its settings spot", () => {
    render(<GettingStartedCard {...props} />);
    const href = (label: string) => within(row(label)).getByRole("link").getAttribute("href");
    expect(href("Set invoice numbering")).toBe("/settings?tab=company#invoice-numbering");
    expect(href("Add bank or UPI")).toBe("/settings?tab=company#payment-details");
    expect(href("Set up sending email")).toBe("/settings?tab=integrations#email-sending");
    expect(href("Invite your team")).toBe("/team");
  });

  it("ticks from saved data and says 'Ready to bill'", () => {
    render(<GettingStartedCard {...props} setup={doneSetup} />);
    for (const label of SETUP_LABELS) expect(isTicked(label), label).toBe(true);
    expect(screen.getByText(/Ready to bill/)).toBeDefined();
  });

  it("renders nothing while a setup fact is still loading", () => {
    const { container } = render(<GettingStartedCard {...props} setup={{ ...freshSetup, email: undefined }} />);
    expect(container.innerHTML).toBe("");
  });

  it("has an anchor the numbering error can link to", () => {
    const { container } = render(<GettingStartedCard {...props} />);
    expect(container.querySelector("#setup-checklist")).not.toBeNull();
  });
});

describe("the checklist as a whole", () => {
  it("retires itself once everything is done", () => {
    const { container } = render(
      <GettingStartedCard {...props} setup={doneSetup} hasCustomer hasCatalog hasQuote hasSale />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("does NOT retire while one setup step is open", () => {
    const { container } = render(
      <GettingStartedCard {...props} setup={{ ...doneSetup, invoiceCode: { saved: null, locked: false } }} hasCustomer hasCatalog hasQuote hasSale />,
    );
    expect(container.innerHTML).not.toBe("");
    expect(isTicked("Set invoice numbering")).toBe(false);
  });

  it("counts progress out of the real number of steps", () => {
    render(<GettingStartedCard {...props} setup={{ ...freshSetup, gstin: VALID_GSTIN, address: "x", stateCode: "07" }} />);
    expect(screen.getByText(/2 of 10 done/)).toBeDefined();
  });

  it("gives every unfinished step somewhere to go", () => {
    /* CLAUDE.md §24 — no dead ends. */
    render(<GettingStartedCard {...props} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(10);
    for (const a of links) expect(a.getAttribute("href")).toMatch(/^\//);
  });
});

describe("R-253 billing gets no button that bounces it to /invoices", () => {
  it("billing sees no setup rows, no /quotes or /items link, and pays via Payments Received", () => {
    mockRole = "billing";
    render(<GettingStartedCard {...props} />);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/quotes"))).toBe(false);
    expect(hrefs.some((h) => h.startsWith("/items"))).toBe(false);
    expect(hrefs.some((h) => h.startsWith("/settings"))).toBe(false);
    expect(within(row("Record your first payment")).getByRole("link").getAttribute("href")).toBe("/payments");
    expect(within(row("Record your first payment")).getByText("Record payment")).toBeDefined();
  });

  it("owner keeps all ten steps", () => {
    mockRole = "owner";
    render(<GettingStartedCard {...props} />);
    expect(screen.getAllByRole("link")).toHaveLength(10);
  });
});
