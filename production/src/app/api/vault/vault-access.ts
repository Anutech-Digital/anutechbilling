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
import { isDeactivated } from "@/lib/auth/deactivated";
import { isMissingColumnError } from "@/lib/auth/session-user";

type ServerClient = ReturnType<typeof createClient>;

export const VAULT_FORBIDDEN =
  "The password vault is only for the workspace owner and managers. Ask one of them for this login.";

export type VaultGate =
  | { ok: true; tenantId: string; role: string }
  | { ok: false; res: NextResponse };

export async function vaultGate(supabase: ServerClient, userId: string): Promise<VaultGate> {
  /* R-1896: a deactivated member, or an ex-employee past their last working day
     (access_ends_on), gets nothing — reveal decrypts with the admin client, so this gate is the
     only check on that path besides the middleware. Falls back if the column is not there yet. */
  type Me = { tenant_id: string | null; role: string; is_active?: boolean | null; access_ends_on?: string | null };
  let res = await supabase.from("users").select("tenant_id, role, is_active, access_ends_on").eq("id", userId).maybeSingle();
  if (res.error && isMissingColumnError(res.error)) {
    res = await supabase.from("users").select("tenant_id, role, is_active").eq("id", userId).maybeSingle();
  }
  const me = (res.data as Me | null) ?? null;

  if (!me?.tenant_id) {
    return { ok: false, res: NextResponse.json({ ok: false, error: "No tenant for this user." }, { status: 403 }) };
  }
  if (isDeactivated(me)) {
    return { ok: false, res: NextResponse.json({ ok: false, error: "Your login has ended. Ask the workspace owner." }, { status: 403 }) };
  }
  if (!can(me.role, "can_reveal_vault")) {
    return { ok: false, res: NextResponse.json({ ok: false, error: VAULT_FORBIDDEN }, { status: 403 }) };
  }
  return { ok: true, tenantId: me.tenant_id, role: me.role };
}
