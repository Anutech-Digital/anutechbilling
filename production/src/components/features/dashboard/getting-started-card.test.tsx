// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { GettingStartedCard } from "./getting-started-card";

/* R-253: the card reads the signed-in role to leave out steps on pages that role cannot open. */
let mockRole: string | null = "owner";
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: mockRole ? { role: mockRole } : undefined }),
}));

afterEach(() => { cleanup(); mockRole = "owner"; });

/* A GSTIN that really passes the checksum — ANUTECH's own (CLAUDE.md §1).
   NOT the wizard's placeholder 27AABCE9876D1Z3: that one is fabricated and FAILS the checksum,
   which is exactly what this component now refuses to tick. */
const VALID_GSTIN = "07ABDCA0298H1ZP";

const props = {
  setupDone: false,
  hasCustomer: false,
  hasCatalog: false,
  hasQuote: false,
  hasSale: false,
  workspaceName: "ANUTECH DIGITAL PVT LTD",
  gstin: null as string | null,
};

/** The row for a step, found by its visible label. */
const row = (label: string) => screen.getByText(label).closest("li") as HTMLElement;
const isTicked = (label: string) => row(label).querySelector("svg") !== null;

describe("the GST step is its own fact", () => {
  it("stays OPEN when the wizard was completed with no GSTIN", () => {
    /* THE BUG THIS SPLIT FIXES. GSTIN is optional in the setup wizard — nothing blocks its
       final Continue with the field empty — so `setup_completed_at` gets stamped either way.
       The old single row ticked "business & GST profile" off that stamp alone, telling a
       reseller their GST profile was set while they held no GSTIN, in an app whose every
       invoice is a GST tax invoice. */
    render(<GettingStartedCard {...props} setupDone gstin={null} />);
    expect(isTicked("Add your organisation")).toBe(true);
    expect(isTicked("Add your GSTIN")).toBe(false);
  });

  it("ticks only once the GSTIN passes format AND checksum", () => {
    render(<GettingStartedCard {...props} setupDone gstin={VALID_GSTIN} />);
    expect(isTicked("Add your GSTIN")).toBe(true);
  });

  it("does not tick a GSTIN that is the right LENGTH but fails the checksum", () => {
    /* A typo in the last character produces a 15-character string that looks right at a
       glance. Length-checking it would put a green tick on an invalid tax identity. */
    render(<GettingStartedCard {...props} setupDone gstin="07ABDCA0298H1ZQ" />);
    expect(isTicked("Add your GSTIN")).toBe(false);
  });

  it("ignores surrounding whitespace rather than failing on it", () => {
    render(<GettingStartedCard {...props} setupDone gstin={`  ${VALID_GSTIN}  `} />);
    expect(isTicked("Add your GSTIN")).toBe(true);
  });

  it("tells the reseller WHY the GSTIN matters", () => {
    /* A step with no reason attached is one people skip — which is how the original defect
       would have happened in practice even with the row present. */
    render(<GettingStartedCard {...props} setupDone />);
    expect(within(row("Add your GSTIN")).getByText(/valid tax invoice/i)).toBeDefined();
  });
});

describe("the checklist as a whole", () => {
  it("shows every step, and none is ticked for a brand-new workspace", () => {
    render(<GettingStartedCard {...props} />);
    for (const label of [
      "Add your organisation",
      "Add your GSTIN",
      "Add your first customer",
      "Load your price list",
      "Create your first quote",
      "Record your first payment",
    ]) {
      expect(isTicked(label), `${label} should start unticked`).toBe(false);
    }
  });

  it("retires itself once everything is done", () => {
    /* No clutter for an active workspace — and the reason ANUTECH's dashboard does not show
       this card today. */
    const { container } = render(
      <GettingStartedCard
        {...props}
        setupDone hasCustomer hasCatalog hasQuote hasSale gstin={VALID_GSTIN}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("does NOT retire while the GSTIN is still missing", () => {
    /* The whole point of the split: a workspace that has done everything else but has no
       GSTIN must keep seeing the card. Before, it would have disappeared. */
    const { container } = render(
      <GettingStartedCard {...props} setupDone hasCustomer hasCatalog hasQuote hasSale gstin={null} />,
    );
    expect(container.innerHTML).not.toBe("");
    expect(isTicked("Add your GSTIN")).toBe(false);
  });

  it("counts progress out of the real number of steps", () => {
    render(<GettingStartedCard {...props} setupDone gstin={VALID_GSTIN} />);
    expect(screen.getByText(/2 of 6 done/)).toBeDefined();
  });

  it("gives every unfinished step somewhere to go", () => {
    /* CLAUDE.md §24 — no dead ends. A checklist row that says what is missing and offers no
       way to fix it is the shape that rule exists to forbid. */
    render(<GettingStartedCard {...props} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(6);
    for (const a of links) expect(a.getAttribute("href")).toMatch(/^\//);
  });
});

describe("R-253 billing gets no button that bounces it to /invoices", () => {
  it("billing sees no /quotes or /items link, and the payment step opens Payments Received", () => {
    /* THE BUG: billing opens the Dashboard, but middleware sends it away from /quotes and
       /items. "New quote", "View quotes" and "Load catalog" threw it back to /invoices. */
    mockRole = "billing";
    render(<GettingStartedCard {...props} />);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.some((h) => h.startsWith("/quotes"))).toBe(false);
    expect(hrefs.some((h) => h.startsWith("/items"))).toBe(false);
    expect(within(row("Record your first payment")).getByRole("link").getAttribute("href")).toBe("/payments");
    expect(within(row("Record your first payment")).getByText("Record payment")).toBeDefined();
  });

  it("owner keeps all six steps", () => {
    mockRole = "owner";
    render(<GettingStartedCard {...props} />);
    expect(screen.getAllByRole("link")).toHaveLength(6);
  });
});
