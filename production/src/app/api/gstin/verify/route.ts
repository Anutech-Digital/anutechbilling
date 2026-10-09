/**
 * POST /api/gstin/verify  (authenticated)
 *
 * Verifies whether a GSTIN is actually registered + active on the GSTN
 * portal. Mathematical (checksum) validation lives in the client/Zod —
 * this route makes the real-world call.
 *
 * Provider abstraction:
 *   1. If process.env.SANDBOX_API_KEY is set → call Sandbox.co.in
 *   2. Otherwise → return a deterministic mock so the UI is testable
 *      without an upstream account.
 *
 * Caching:
 *   On success we persist the normalised payload + a verified_at timestamp
 *   on the tenants row, so re-opening Settings doesn't re-charge a call.
 *
 * Body:    { gstin: string, save?: boolean }
 * Returns: { ok: true, verification: GstinVerification, cached?: boolean }
 *        | { ok: false, error: string }
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { isValidGstin }      from "@/lib/utils";
import { mockGstinVerification } from "@/lib/gst/mock-gstin";
import type { GstinVerification } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

const schema = z.object({
  gstin: z.string().min(15).max(15),
  /** When true (default), persist the verification result.
   *  - If `customer_id` is provided, write to that customers row.
   *  - Otherwise write to the tenant row (Settings → Company use case). */
  save:        z.boolean().optional(),
  customer_id: z.string().optional(),
});

// ──────────────────────────────────────────────────────────────────────
// Sandbox.co.in provider
//
// Two-step auth flow (per https://docs.sandbox.co.in/api/authentication):
//   1. POST  /authenticate  with x-api-key + x-api-secret  → access_token
//   2. GET   /gst/compliance/public/gstins/{gstin}
//        with x-api-key + Authorization: <token>           → GSTIN payload
//
// We cache the token in-memory (per api_key) until ~5 min before it
// expires, so back-to-back verifications cost one upstream call.
// Credentials are read PER TENANT from tenant_secrets — falling back to
// process.env for dev/dogfood (single-tenant case).
// ──────────────────────────────────────────────────────────────────────
interface SandboxCreds { apiKey: string; apiSecret: string; baseUrl: string }

interface CachedToken { token: string; expiresAt: number }
const sandboxTokenCache = new Map<string, CachedToken>();

async function sandboxAuthenticate(creds: SandboxCreds): Promise<string> {
  const cached = sandboxTokenCache.get(creds.apiKey);
  if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;

  const res = await fetch(`${creds.baseUrl}/authenticate`, {
    method:  "POST",
    headers: {
      "x-api-key":     creds.apiKey,
      "x-api-secret":  creds.apiSecret,
      "x-api-version": "1.0",
      "accept":        "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sandbox auth ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json() as { access_token?: string; data?: { access_token?: string }; expires?: number | string };
  const token = json.access_token ?? json.data?.access_token;
  if (!token) throw new Error("Sandbox auth: no access_token in response");

  // Sandbox tokens are typically valid 10 hours. We treat anything missing
  // as a 30-min TTL to be safe and re-auth often.
  const ttlMs = typeof json.expires === "number" ? json.expires * 1000 : 30 * 60_000;
  sandboxTokenCache.set(creds.apiKey, { token, expiresAt: Date.now() + ttlMs });
  return token;
}

/**
 * Sandbox.co.in GSTIN search — verified from the live Postman collection
 * (Sandbox API · GST > Compliance > Public > Search GSTIN):
 *
 *   POST {{baseUrl}}/gst/compliance/public/gstin/search
 *   Body: { "gstin": "<15-char gstin>" }
 *   Headers: x-api-key, x-api-version, Authorization (token), Content-Type
 */
async function verifyViaSandbox(gstin: string, creds: SandboxCreds): Promise<GstinVerification> {
  const token = await sandboxAuthenticate(creds);
  const url   = `${creds.baseUrl}/gst/compliance/public/gstin/search`;
  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "x-api-key":     creds.apiKey,
      "x-api-version": "1.0",
      "authorization": token,
      "content-type":  "application/json",
      "accept":        "application/json",
    },
    body: JSON.stringify({ gstin }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    // Token might have rotated server-side — invalidate cache so the next
    // attempt re-authenticates fresh.
    if (res.status === 401) sandboxTokenCache.delete(creds.apiKey);
    const text = await res.text();
    throw new Error(`Sandbox responded ${res.status}: ${text.slice(0, 200)}`);
  }
  const json: unknown = await res.json();
  console.log("[sandbox] raw GSTIN response:", JSON.stringify(json).slice(0, 1500));
  return normaliseSandbox(json);
}

/** Map Sandbox.co.in's response onto our internal shape.
 *  Sandbox returns one of two shapes:
 *    A) GSTN raw codes: { data: { lgnm, tradeNam, ctb, dty, sts, pradr: { addr } } }
 *    B) Sandbox-normalised long names: { data: { gstin: { legal_name_of_business,
 *       gst_in_status, principal_place_of_business, ... } } }
 *  We try both — first match wins. */
function normaliseSandbox(raw: unknown): GstinVerification {
  const root = (raw && typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : {};
  // Sandbox wraps responses in nested `data` envelopes — typical shape is
  //   { code: 200, data: { data: { lgnm, tradeNam, pradr, ... }, status_cd } }
  // We drill until we find the row that has at least one GSTN field.
  let r: Record<string, unknown> =
    (root.data as Record<string, unknown> | undefined) ?? root;
  const looksLikeRow = (o: unknown) =>
    !!o && typeof o === "object" &&
    ("lgnm" in (o as object) || "gstin" in (o as object) ||
     "legal_name" in (o as object) || "legal_name_of_business" in (o as object));
  if (!looksLikeRow(r)) {
    if (looksLikeRow(r.data))    r = r.data    as Record<string, unknown>;
    else if (looksLikeRow(r.gstin))   r = r.gstin   as Record<string, unknown>;
    else if (looksLikeRow(r.details)) r = r.details as Record<string, unknown>;
  }

  const pickStr = (obj: Record<string, unknown>, ...keys: string[]): string | null => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };

  // Principal address — Sandbox's long-name shape uses
  // `principal_place_of_business` (flat string) OR nested `principal_place_address`.
  // GSTN raw shape uses `pradr.addr.{bno,bnm,st,...}`.
  const pradrCandidates = [
    r.pradr,
    r.principal_place_address,
    r.principal_address,
  ].filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
  const pradr = pradrCandidates[0] ?? {};
  const addrCandidates = [
    pradr.addr,
    pradr.address,
    pradr,
  ].filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
  const addr = addrCandidates[0] ?? {};

  const flatAddress =
    pickStr(pradr, "adr") ??
    pickStr(r,     "principal_place_of_business",
                   "principal_place_of_business_address",
                   "address",
                   "principal_address_text");

  const building = [
    pickStr(addr, "bno", "building_number"),
    pickStr(addr, "bnm", "building_name"),
    pickStr(addr, "flno", "floor_number"),
  ].filter(Boolean).join(", ");

  // Note: in Sandbox's response, `addr.stcd` holds the state NAME
  // ("Delhi"), not the GST code ("07"). The actual GST state code is
  // implicit in the first 2 chars of the GSTIN itself (see below).
  const principal_address = (Object.keys(addr).length || flatAddress) ? {
    building:   building || null,
    street:     pickStr(addr, "st",   "street"),
    locality:   pickStr(addr, "loc",  "locality", "landMark", "landmark"),
    city:       pickStr(addr, "city", "town", "dst", "district"),
    district:   pickStr(addr, "dst",  "district"),
    state:      pickStr(addr, "stcd", "state_code", "state"),
    pin_code:   pickStr(addr, "pncd", "pin_code", "pincode"),
  } : null;

  // Derive the GST state code from the GSTIN itself — the first 2 digits.
  // Don't trust `addr.stcd` (it holds the state NAME per the response shape).
  const gstinStr   = pickStr(r, "gstin");
  const stateCode2 = gstinStr && /^\d{2}/.test(gstinStr) ? gstinStr.slice(0, 2) : null;

  const composedAddress =
    flatAddress ??
    (principal_address
      ? [
          principal_address.building,
          principal_address.street,
          principal_address.locality,
          principal_address.city,
          principal_address.state,
          principal_address.pin_code,
        ].filter(Boolean).join(", ") || null
      : null);

  return {
    status:             pickStr(r, "sts", "status", "gst_in_status", "gstn_status") ?? "Unknown",
    legal_name:         pickStr(r, "lgnm",     "legal_name", "legal_name_of_business", "legalName"),
    trade_name:         pickStr(r, "tradeNam", "trade_name", "trade_name_of_business", "tradeName"),
    constitution:       pickStr(r, "ctb",      "constitution_of_business", "constitution"),
    registration_type:  pickStr(r, "dty",      "tax_payer_type", "taxpayer_type", "tax_payer_type_v2"),
    valid_from:         pickStr(r, "rgdt",     "registration_date", "date_of_registration", "valid_from"),
    valid_upto:         pickStr(r, "nba",      "valid_upto", "date_of_cancellation"),
    last_return_filed:  pickStr(r, "lstupdt",  "last_return_filed", "last_updated"),
    jurisdiction:       pickStr(r, "ctj",      "centre_jurisdiction", "stj", "state_jurisdiction"),
    // First 2 digits of GSTIN = canonical GST state code. The top-level
    // "stcd" is ALSO this code in some shapes, but `pradr.addr.stcd` is the
    // state NAME — so we DON'T fall back through principal_address here.
    state_code:         stateCode2 ?? pickStr(r, "stcd", "state_code"),
    principal_address,
    address:            composedAddress,
    source:             "sandbox",
    raw,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Mock provider — deterministic from GSTIN so the UI is testable.
// First 2 digits = state code, first 5 letters after = PAN's name part.
// ──────────────────────────────────────────────────────────────────────
function mockVerify(gstin: string): GstinVerification {
  /* R-526: the address follows the GSTIN's state (lib/gst/mock-gstin.ts) — it was always Mumbai. */
  return mockGstinVerification(gstin);
}

// ──────────────────────────────────────────────────────────────────────
// Route handler
// ──────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Send { gstin: 'AAAA...' }" }, { status: 400 });
  }
  const gstin       = parsed.data.gstin.toUpperCase().trim();
  const save        = parsed.data.save !== false;  // default true
  const customer_id = parsed.data.customer_id ?? null;

  // Format + checksum first — saves an upstream call on bad input
  if (!isValidGstin(gstin)) {
    return NextResponse.json(
      { ok: false, error: "GSTIN is malformed or has a bad checksum — fix that first" },
      { status: 400 },
    );
  }

  // Authenticated user only — RLS-scoped tenant for the save step
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const admin = createAdminClientFor(authData.user.id);
  const { data: me } = await supabase
    .from("users").select("tenant_id").eq("id", authData.user.id).single();

  // Resolve credentials: tenant_secrets → process.env → mock.
  let creds: SandboxCreds | null = null;
  if (me?.tenant_id) {
    const { data: secrets } = await admin
      .from("tenant_secrets")
      .select("sandbox_api_key, sandbox_api_secret, sandbox_api_base")
      .eq("tenant_id", me.tenant_id)
      .maybeSingle();
    if (secrets?.sandbox_api_key && secrets.sandbox_api_secret) {
      creds = {
        apiKey:    secrets.sandbox_api_key,
        apiSecret: secrets.sandbox_api_secret,
        baseUrl:   secrets.sandbox_api_base ?? "https://api.sandbox.co.in",
      };
    }
  }
  if (!creds && process.env.SANDBOX_API_KEY && process.env.SANDBOX_API_SECRET) {
    creds = {
      apiKey:    process.env.SANDBOX_API_KEY.trim(),
      apiSecret: process.env.SANDBOX_API_SECRET.trim(),
      baseUrl:   process.env.SANDBOX_API_BASE?.trim() || "https://api.sandbox.co.in",
    };
  }
  const providerConfigured = creds !== null;

  let verification: GstinVerification;
  try {
    verification = providerConfigured ? await verifyViaSandbox(gstin, creds!) : mockVerify(gstin);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[/api/gstin/verify] provider failed:", msg);
    return NextResponse.json(
      { ok: false, error: "Could not reach GSTIN provider. Try again in a few seconds." },
      { status: 502 },
    );
  }

  // Persist the verification result. Two save modes:
  //   - customer_id supplied → save against that customers row (must
  //     belong to the same tenant). Useful for AddCustomerForm.
  //   - else → save against the tenant row (only if the verified GSTIN
  //     matches tenant.gstin — prevents accidental writes when a visitor
  //     is testing a different GSTIN).
  // Best-effort either way — verification result already lives in the
  // response, so a persistence failure isn't fatal.
  if (save) {
    try {
      if (me?.tenant_id) {
        const admin = createAdminClientFor(authData.user.id);
        if (customer_id) {
          const { data: customer } = await admin
            .from("customers")
            .select("gstin, tenant_id")
            .eq("id", customer_id)
            .single();
          if (customer?.tenant_id === me.tenant_id) {
            const patch: { gstin_verified_at: string; gstin_verification: GstinVerification; gstin?: string } = {
              gstin_verified_at:  new Date().toISOString(),
              gstin_verification: verification,
            };
            // First-time set: if customer didn't have a GSTIN yet, fill it.
            if (!customer.gstin) patch.gstin = gstin;
            await admin.from("customers").update(patch).eq("id", customer_id);
          }
        } else {
          const { data: tenant } = await admin
            .from("tenants").select("gstin").eq("id", me.tenant_id).single();
          if (tenant?.gstin && tenant.gstin.toUpperCase() === gstin) {
            await admin
              .from("tenants")
              .update({
                gstin_verified_at:  new Date().toISOString(),
                gstin_verification: verification,
              })
              .eq("id", me.tenant_id);
          }
        }
      }
    } catch (e) {
      // Persistence is best-effort — the verification itself succeeded.
      console.warn("[/api/gstin/verify] could not persist:", e);
    }
  }

  return NextResponse.json({
    ok:           true,
    verification,
    mock:         !providerConfigured,
  });
}
