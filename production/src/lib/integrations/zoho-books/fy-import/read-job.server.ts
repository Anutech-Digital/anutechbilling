/**
 * R-2607 — one server pass of the FY read for ONE company: its own Zoho connection, its own scan,
 * its own lease. Used by the dialog's route (the signed-in caller's tenant) and by the cron
 * zoho-fy-read (each asked-for run's own tenant). Zoho is only read; nothing is imported.
 */
import "server-only";
import { NOT_CONFIGURED_MESSAGE, zohoBooksCreds } from "../config";
import type { FyReadKind, ZohoFyDocDetail } from "../fy-fetch";
import { dropZohoAccessToken, readConnection, zohoAccessToken, type ZohoCaller } from "../store";
import { zohoReceiptFacts } from "../receipts-import/normalise";
import { runBackgroundRead, type PassResult, type ZohoAccess } from "./background-read";
import { supabaseBgStore } from "./bg-store";
import { supabaseScanStore, type FyImportDb } from "./store";
import type { ScanFacts } from "./scan";

/** The lists whose FY read runs on the server (R-2607: FY receipts first). */
export const BACKGROUND_READ_KINDS: Partial<Record<FyReadKind, (d: ZohoFyDocDetail) => ScanFacts>> = {
  customerpayments: zohoReceiptFacts,
};

export function zohoAccessFor(admin: ZohoCaller["admin"], tenantId: string): () => Promise<ZohoAccess> {
  return async () => {
    const creds = zohoBooksCreds();
    if (!creds) return { error: NOT_CONFIGURED_MESSAGE };
    const conn = await readConnection(admin, tenantId);
    if (!conn.refreshToken) return { error: "Zoho Books is not connected. Settings → Integrations → Zoho Books → Connect." };
    if (!conn.orgId) return { error: "Choose your Zoho Books organization first." };
    const who = { admin, tenantId };
    return { orgId: conn.orgId, token: () => zohoAccessToken(who, conn.refreshToken!, creds), dropToken: () => dropZohoAccessToken(who) };
  };
}

export async function companyReadPass(
  admin: ZohoCaller["admin"], tenantId: string, kind: FyReadKind, fy: string,
  opts: { budgetMs: number; requireRequest: boolean },
): Promise<PassResult | null> {
  const toFacts = BACKGROUND_READ_KINDS[kind];
  if (!toFacts) return null;
  const db = admin as unknown as FyImportDb;
  return runBackgroundRead({
    store: supabaseScanStore(db, tenantId, kind),
    bg: supabaseBgStore(db, tenantId, kind),
    kind, toFacts, fy,
    access: zohoAccessFor(admin, tenantId),
    budgetMs: opts.budgetMs,
    requireRequest: opts.requireRequest,
  });
}
