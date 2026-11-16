/**
 * R-2758 (R-2739a): the Renewals row's ONE button + ⋯ list, from the stage (lib/renewals/stage.ts
 * renewalPrimary) narrowed to what this person may open. Pure — tested in stage-actions-r2758.test.ts.
 *
 *   - Record payment needs a target the person can open and money rights (canPay); without it a
 *     primary Record payment becomes Follow up (when the screen offers it), else no button.
 *   - Resend invoice needs the invoices page.
 *   - rev-r2738 SAFE note: a whole-term row whose linked renewal quote is closed (expired / rejected /
 *     cancelled) offered only Follow up — no way on. "Open quote" (⋯) opens that quote, where it can be
 *     revised or released; a second renewal quote is still never offered (R-2232).
 */
import {
  renewalPrimary, MENU_LABEL, FOLLOW_UP, SEND_RENEWAL,
  type MenuItem, type PrimaryAction, type PrimaryContext, type PrimaryKind, type RenewalStage, type StageSub,
} from "@/lib/renewals/stage";
import { canRenewAnyway } from "@/lib/renewals/vendor-hold";

/** "send-renewal" (R-2859): the row's own Send renewal, in ⋯ while the row's button is Bill together. */
export type StageMenuItem = MenuItem | "open-quote" | "send-renewal";
export type StageRunKind = PrimaryKind | StageMenuItem;

export const STAGE_MENU_LABEL: Record<StageMenuItem, string> = { ...MENU_LABEL, "open-quote": "Open the closed quote", "send-renewal": SEND_RENEWAL };

export interface StagePerms {
  canQuotes: boolean;
  canPay: boolean;
  canInvoices: boolean;
}

export interface StageButtons {
  primary: PrimaryAction | null;
  menu: StageMenuItem[];
  graceOver: boolean;
}

export function stageButtons(stage: RenewalStage, sub: StageSub, ctx: PrimaryContext, perms: StagePerms): StageButtons {
  const r = renewalPrimary(stage, sub, ctx);
  let primary = r.primary;
  if (primary?.kind === "record-payment" && !perms.canPay) {
    primary = ctx.offers.followup ? { kind: "follow-up", label: FOLLOW_UP, opensEditor: false, quoteId: stage.quoteId, invoiceId: stage.invoiceId } : null;
  }
  const menu: StageMenuItem[] = r.menu.filter((m) => {
    if (m === "record-payment") return perms.canPay;
    if (m === "resend-invoice") return perms.canInvoices && !!stage.invoiceId;
    if (m === "follow-up") return primary?.kind !== "follow-up";
    return true;
  });
  if (stage.key === "quote-closed" && perms.canQuotes && stage.quoteId) menu.unshift("open-quote");
  /* code-review: the row's old vendor-hold badge let owner / manager Renew anyway inside the grace too —
     kept, now as a ⋯ item (renewalPrimary adds it only once grace is over). */
  if (ctx.vendorHold === "hold" && canRenewAnyway(ctx.role) && stage.key !== "renewed" && stage.key !== "stopped" && stage.key !== "ending"
    && !menu.includes("renew-anyway")) {
    const at = menu.indexOf("not-renewing");
    menu.splice(at < 0 ? menu.length : at, 0, "renew-anyway");
  }
  return { primary, menu, graceOver: r.graceOver };
}

/**
 * R-2859 — a row that Bill together suggests with others (the box above the queue, "Bills with …" on the row):
 * its ONE button is "Bill together" — the same dialog the box opens — instead of its own Bill next part / Send
 * renewal, which bills only that one subscription (staging 16 Nov: the box offered one bill for the pair while
 * each row still offered its own Bill next part — two ways, and two proformas if both were pressed).
 * Only the button that would bill THIS row alone is replaced: a parts group's Bill next part, a yearly group's Send
 * renewal. Follow up / Record payment / Continue stay as they are. The row's own action moves to ⋯ (first) — Bill next
 * part (ownerRule 3) / Send renewal — so one subscription can still be billed alone, with the same check-first path.
 */
export interface TogetherRowAction {
  /** The suggested group's kind: "parts" = one proforma, "renewal" = one renewal quote (yearly). */
  kind: "parts" | "renewal";
  label: string;
  title: string;
  onClick: () => void;
  /** The "is Bill together there?" check is still out: the button shows (no swap once it answers) but cannot be pressed. */
  pending?: boolean;
}

const ALONE_KIND: Record<TogetherRowAction["kind"], PrimaryKind> = { parts: "bill-part", renewal: "send-renewal" };

/** `together` in the result = the action the row's button runs (null = the row's own primary). */
export function withTogether<T extends Pick<TogetherRowAction, "kind">>(b: StageButtons, together: T | null | undefined): StageButtons & { together: T | null } {
  if (!together) return { ...b, together: null };
  const alone = ALONE_KIND[together.kind];
  if (b.primary?.kind !== alone) return { ...b, together: null };
  const menu: StageMenuItem[] = b.menu.includes(alone as StageMenuItem) ? b.menu : [alone as StageMenuItem, ...b.menu];
  return { ...b, menu, together };
}
