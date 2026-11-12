/**
 * R-2704 (G-FY2526) — the FY Zoho import dialogs remember which app account each Zoho account goes to,
 * per company (table zoho_account_bank_map, written only by save_zoho_account_bank_choice).
 *
 *   receipts  — key = Zoho deposit account id   (FY receipts dialog, "Where the money went")
 *   purchases — key = Zoho paid-through name     (FY purchase dialog, "Paid from")
 *
 * The routes read the saved choices and put the dialog's own map ON TOP: what the screen sends always
 * wins; a saved choice only fills an account the screen did not send. Both imports use "none" for
 * Leave these out (receipts-import/plan LEAVE_OUT, purchase-import/plan LEAVE_OUT).
 */
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { FyImportDb } from "./store";

export type AccountChoiceUse = "receipts" | "purchases";
export const ACCOUNT_CHOICE_LEAVE_OUT = "none";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** This company's saved choices for one import: Zoho key → app account id | "none". */
export async function readAccountChoices(db: FyImportDb, tenantId: string, use: AccountChoiceUse): Promise<Record<string, string>> {
  const rows = await fetchAllRows<{ zoho_key: string; bank_account_id: string | null; leave_out: boolean }>((from, to) =>
    db.from("zoho_account_bank_map").select("zoho_key, bank_account_id, leave_out")
      .eq("tenant_id", tenantId).eq("use_for", use).order("zoho_key", { ascending: true }).range(from, to));
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.leave_out) out[r.zoho_key] = ACCOUNT_CHOICE_LEAVE_OUT;
    else if (r.bank_account_id) out[r.zoho_key] = r.bank_account_id;
  }
  return out;
}

/** The map a preview uses: the saved choices, with whatever the dialog sent on top (the screen wins). */
export function withSavedChoices(saved: Record<string, string>, sent: Record<string, string>): Record<string, string> {
  return { ...saved, ...sent };
}

/** The dialog's "remember this" request: { use, key, choice } — choice = account id, "none", or "" (forget). */
export function parseSaveChoice(body: Record<string, unknown>, use: AccountChoiceUse): { use: AccountChoiceUse; key: string; choice: string } | null {
  const key = typeof body.zohoKey === "string" ? body.zohoKey.trim() : "";
  const choice = typeof body.choice === "string" ? body.choice.trim() : "";
  if (!key || key.length > 200) return null;
  if (choice !== "" && choice !== ACCOUNT_CHOICE_LEAVE_OUT && !UUID.test(choice)) return null;
  return { use, key, choice };
}
