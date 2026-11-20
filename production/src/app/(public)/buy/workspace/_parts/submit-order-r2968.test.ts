/**
 * R-2968: when the server joined the request to an earlier one (alreadyRequested), the buy page says
 * "Your trial is already requested — our team will contact you <SLA>" instead of "Trial requested!".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { startTrial, requestQuote, type SubmitContext } from "./submit-order";
import { SLA } from "@/site/lib/config";
import { EMPTY_BUYER, EMPTY_DOMAIN } from "./checkout-form";
import type { BuyPlan } from "./plans";

const ctx: SubmitContext = {
  plan: { id: "standard", name: "Business Standard" } as BuyPlan,
  seats: 5,
  billing: "annual",
  domain: { ...EMPTY_DOMAIN, domain: "ravitraders.in" },
  buyer: { ...EMPTY_BUYER, name: "Ravi Kumar", company: "Ravi Traders", email: "ravi@example.invalid", phone: "07000 000001" },
  ts: { headers: {}, reset: () => {} },
  sellerName: "Seller",
};

function answer(json: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } })));
}

beforeEach(() => { toast.success.mockReset(); toast.error.mockReset(); });

describe("R-2968 buy page — asked again", () => {
  it("trial joined an earlier request → 'already requested' with the SLA", async () => {
    answer({ success: true, leadId: "L-1", alreadyRequested: true });
    expect(await startTrial(ctx, () => {})).toBe(true);
    expect(toast.success).toHaveBeenCalledWith(`Your trial is already requested — our team will contact you ${SLA.firstReply}.`);
  });

  it("a first trial request keeps 'Trial requested!'", async () => {
    answer({ success: true, leadId: "L-1" });
    await startTrial(ctx, () => {});
    expect(String(toast.success.mock.calls[0][0])).toMatch(/^Trial requested!/);
  });

  it("quote joined an earlier request → 'We already have your request'", async () => {
    answer({ success: true, leadId: "L-1", alreadyRequested: true });
    expect(await requestQuote(ctx, () => {})).toBe(true);
    expect(toast.success).toHaveBeenCalledWith(`We already have your request — our team will contact you ${SLA.firstReply}.`);
  });
});
