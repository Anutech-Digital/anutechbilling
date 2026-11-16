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
  renewalPrimary, MENU_LABEL, FOLLOW_UP,
  type MenuItem, type PrimaryAction, type PrimaryContext, type PrimaryKind, type RenewalStage, type StageSub,
} from "@/lib/renewals/stage";
import { canRenewAnyway } from "@/lib/renewals/vendor-hold";

export type StageMenuItem = MenuItem | "open-quote";
export type StageRunKind = PrimaryKind | StageMenuItem;

export const STAGE_MENU_LABEL: Record<StageMenuItem, string> = { ...MENU_LABEL, "open-quote": "Open the closed quote" };

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
