/**
 * R-716 — who may use the customer credential vault.
 *
 * The /vault menu was owner/manager only (nav.ts), but the API routes behind it only checked
 * "signed in", and the RLS policies only checked "same tenant". So any member — a sales rep,
 * a support login — could POST /api/vault/[id]/reveal and get a customer's Google Admin /
 * M365 / registrar password decrypted, or add credentials of their own.
 *
 * Now every vault route asks this first: the caller's role must have `can_reveal_vault`
 * (owner, manager — src/lib/auth/roles.ts). RLS says the same thing again
 * (20261011031600_r716_vault_owner_manager.sql), so a bug here still cannot leak a row.
 * The role is read from `public.users`, never from anything the client sends.
 */
import { NextResponse } from "next/server";
import type { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/auth/roles";

type ServerClient = ReturnType<typeof createClient>;

export const VAULT_FORBIDDEN =
  "The password vault is only for the workspace owner and managers. Ask one of them for this login.";

export type VaultGate =
  | { ok: true; tenantId: string; role: string }
  | { ok: false; res: NextResponse };

export async function vaultGate(supabase: ServerClient, userId: string): Promise<VaultGate> {
  const { data: me } = await supabase
    .from("users")
    .select("tenant_id, role")
    .eq("id", userId)
    .maybeSingle();

  if (!me?.tenant_id) {
    return { ok: false, res: NextResponse.json({ ok: false, error: "No tenant for this user." }, { status: 403 }) };
  }
  if (!can(me.role, "can_reveal_vault")) {
    return { ok: false, res: NextResponse.json({ ok: false, error: VAULT_FORBIDDEN }, { status: 403 }) };
  }
  return { ok: true, tenantId: me.tenant_id, role: me.role };
}
