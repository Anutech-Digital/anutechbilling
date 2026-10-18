/**
 * Meta WhatsApp webhook handshake (GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…)
 * — one place for both WhatsApp routes (sales: /api/webhooks/whatsapp, support:
 * /api/v1/integrations/support-whatsapp-inbound).
 *
 * ─── R-1550: TOKEN ENVELOPE ME BAND THA, COMPARE BAAHAR WALE SE ─────────────
 * `whatsapp_verify_token` SECRET_COLUMNS me hai (lib/crypto/tenant-secrets.ts), isliye
 * /api/integrations/seal use `rosv1:…` envelope me band kar deta hai. Dono route row ka value
 * BINA `decryptTenantSecrets` ke Meta ke token se mila rahe the — seal ke baad har handshake
 * 403, aur Meta dashboard ka "Verify and save" kabhi pass nahi hota. Ab pehle decrypt, phir
 * constant-time compare.
 *
 * ─── R-1550: ALAG JAWAB = KIS COMPANY NE WHATSAPP LAGAYA ────────────────────
 * Pehle "no verify token configured" aur "verify_token mismatch" alag aate the — koi bhi
 * tenant id daal kar pata kar leta kis company ne WhatsApp lagaya hai. Ab "aisi company nahi /
 * token nahi / galat token / envelope khul nahi saka" sab ka EK hi 403 body.
 */
import { NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";

type VerifyRow = { whatsapp_verify_token?: string | null };

/** Every refusal gets this one body, so the answer says nothing about the tenant. */
export function handshakeRefused(): NextResponse {
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

/**
 * Meta's token vs the stored one (sealed envelope or legacy plaintext). No row, no token, or an
 * envelope that will not open (wrong SECRETS_MASTER_KEY / altered row) → false, never a throw.
 */
export function verifyTokenMatches(given: string | null | undefined, row: VerifyRow | null | undefined): boolean {
  if (!given || !row?.whatsapp_verify_token) return false;
  let stored: string | null | undefined;
  try {
    stored = decryptTenantSecrets(row)?.whatsapp_verify_token;
  } catch {
    /* The reason goes to the server log only — never the value or the envelope. */
    console.error("[whatsapp/handshake] stored verify token could not be decrypted — check SECRETS_MASTER_KEY");
    return false;
  }
  return timingSafeEqualStr(given, stored);
}

/** The whole GET answer: the challenge as text/plain 200, or the one 403. */
export async function answerHandshake(
  url: URL,
  loadRow: (tenantId: string) => Promise<VerifyRow | null>,
): Promise<NextResponse> {
  const tenantId  = url.searchParams.get("tenant");
  const mode      = url.searchParams.get("hub.mode");
  const token     = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (!tenantId) return NextResponse.json({ error: "missing tenant" }, { status: 400 });
  if (mode !== "subscribe" || !token || !challenge) {
    return NextResponse.json({ error: "invalid handshake" }, { status: 400 });
  }

  if (!verifyTokenMatches(token, await loadRow(tenantId))) return handshakeRefused();

  // Echo the challenge back as plain text — Meta needs this exact body.
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}
