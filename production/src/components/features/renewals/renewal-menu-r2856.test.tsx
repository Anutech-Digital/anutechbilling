// @vitest-environment jsdom
/**
 * R-2856 — the row's ⋯ read "Follow up · Nudge · Voice note · Renew anyway · Customer not renewing":
 * Follow up vs Nudge vs Voice note are look-alike words (16 Nov human test). What each really does
 * (renewal-actions.tsx): Follow up opens the follow-up dialog (log a call / promise / next date);
 * Nudge has AI draft a WhatsApp renewal message that YOU edit and send; Voice note sends a Hindi
 * voice-note reminder on WhatsApp (asks first). Each ⋯ item now says that action; the row's one
 * button stays "Follow up" (R-2767: one verb per intention — the item starts with the same words).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { MENU_LABEL, FOLLOW_UP, renewalStage, type RenewalStage } from "@/lib/renewals/stage";
import { RenewalActions, type RenewalActionsSub } from "./renewal-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(cleanup);

describe("R-2856 ⋯ labels say the action", () => {
  it("each of the three says what happens; no two items share a look-alike word", () => {
    expect(FOLLOW_UP).toBe("Follow up");   // the row's button — unchanged
    expect(MENU_LABEL["follow-up"]).toBe("Follow up — log a call or promise");
    expect(MENU_LABEL.nudge).toBe("Draft a WhatsApp message (AI)");
    expect(MENU_LABEL.voice).toBe("Send a WhatsApp voice note");
    const labels = Object.values(MENU_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.join(" | ")).not.toMatch(/Nudge/);
  });
});

const SUB: RenewalActionsSub = {
  id: "s-1", customer_name: "Ravi Shankar", plan: "Google Workspace", status: "active", renewal_state: "pending",
  outstanding_amount: 0, start_date: "2025-11-01", quote_id: null, renewal_quote_id: null, renewal_date: "2026-11-30",
  auto_renew: true, billing_cycle: "yearly", term_months: 12, customer_id: "c-1",
} as RenewalActionsSub;

function openMenu() {
  const trigger = screen.getByTestId("stage-more");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("R-2856 the Renewals row's ⋯ (RTL)", () => {
  it("a due row: the button is Send renewal; ⋯ lists the follow-up, the WhatsApp draft and the voice note by what they do", () => {
    const stage: RenewalStage = renewalStage({ sub: SUB as never, todayIst: "2026-11-16" });
    const onFollowup = vi.fn();
    /* the lazy row (R-2764): button + ⋯ with no per-row hooks — Follow up runs without mounting the full component */
    render(<RenewalActions sub={SUB} daysUntil={14} layout="table" onFollowup={onFollowup} messaging stage={stage}
      viewer={{ role: "owner", tenantGracePeriodDays: 0 }} />);
    expect(screen.getByTestId("stage-primary").textContent).toContain("Send renewal");
    openMenu();
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
    expect(items).toContain("Follow up — log a call or promise");
    expect(items).toContain("Draft a WhatsApp message (AI)");
    expect(items).toContain("Send a WhatsApp voice note");
    expect(items.some((t) => /^(Nudge|Voice note|Follow up)$/.test(t ?? ""))).toBe(false);
    /* the tooltips keep the detail */
    expect(screen.getByRole("menuitem", { name: /Draft a WhatsApp message/ }).getAttribute("title")).toMatch(/you edit and send it yourself/);
    expect(screen.getByRole("menuitem", { name: /Send a WhatsApp voice note/ }).getAttribute("title")).toMatch(/asks first/);
    fireEvent.click(screen.getByRole("menuitem", { name: /Follow up — log a call or promise/ }));
    expect(onFollowup).toHaveBeenCalledTimes(1);
  });
});
