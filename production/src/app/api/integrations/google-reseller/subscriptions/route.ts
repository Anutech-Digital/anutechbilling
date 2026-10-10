/**
 * GET /api/integrations/google-reseller/subscriptions
 *
 * Pulls ALL of the reseller's Google Workspace subscriptions live from the
 * Reseller API. Returns normalized rows the subscriptions "Add missing from
 * Google" matcher can classify + import.
 *
 * R-824: the token comes from getGoogleAccessToken("reseller") — the company's
 * "Connect Google Reseller" connection (refreshed server-side), else the sign-in
 * session (Auth.js cookie, refreshed; or Supabase's provider_token). It never
 * reaches the browser (R-528). Failures answer { code, error } in plain English:
 *   not_connected / missing_scope → "Connect Google Reseller to see subscriptions"
 *   needs_reauth                  → "Google needs you to sign in again"
 *   api_disabled                  → "The Reseller API is turned off in Google Cloud"
 *
 * Owner does this ONCE in Google Cloud Console (we can't — it's their account):
 *   1. Enable "Google Workspace Reseller API" in the OAuth project.
 *   2. OAuth consent screen → add scope https://www.googleapis.com/auth/apps.order
 *   3. Credentials → OAuth client → authorised redirect URI
 *        <app origin>/api/integrations/google-reseller/callback
 *   4. Settings → Integrations → Connect Google Reseller (reseller-admin account).
 *
 * Read-only: this NEVER writes to Google or the DB. It only reads subscriptions.
 *
 * Docs: https://developers.google.com/workspace/admin/reseller/reference/rest/v1/subscriptions/list
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { classifyGoogleApiError, getGoogleAccessToken, googleReasonMessage } from "@/server/auth/google-token";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Minimal shape of the Reseller API Subscription resource (only fields we use).
interface ResellerSub {
  customerId?: string;
  customerDomain?: string;
  skuId?: string;
  skuName?: string;
  status?: string;        // ACTIVE | SUSPENDED | PENDING | ...
  creationTime?: string;  // epoch ms (string)
  seats?: { numberOfSeats?: number; licensedNumberOfSeats?: number; maximumNumberOfSeats?: number };
  plan?: { planName?: string; commitmentInterval?: { startTime?: string; endTime?: string } };
  renewalSettings?: { renewalType?: string };
}
interface ResellerListResponse {
  subscriptions?: ResellerSub[];
  nextPageToken?: string;
}

// What the client matcher consumes (mirrors RawSub in google-subs-parse.ts).
interface NormalizedSub {
  domain: string;
  sku: string;
  seats: number;
  status: "active" | "paused";
  start_date?: string;
  renewal_date?: string;
}

function msToISO(ms?: string): string | undefined {
  if (!ms) return undefined;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n).toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  // probe=1 → lightweight status check (1 row) for the Settings card; no full pull.
  const probe = new URL(req.url).searchParams.get("probe") === "1";

  const supabase = createClient();
  /* Pehchan getUser() se — wo JWT ko SERVER par verify karta hai (audit C8). Google ka
     token phir getGoogleAccessToken() server par hi dhoondta hai (R-824). */
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  /* A setup state is not a failure of the probe: the Settings card asks "what is the state?"
     and gets a 200 with the answer, so the browser console stays clean. The full pull (import
     dialog) keeps 403, which its toast logic expects. */
  const notReady = (code: string, error: string, detail?: string) =>
    NextResponse.json(
      probe ? { connected: false, code, error } : { code, error, ...(detail ? { detail } : {}) },
      { status: probe ? 200 : 403 },
    );

  const got = await getGoogleAccessToken("reseller", user.id);
  if (!got.ok) return notReady(got.reason, googleReasonMessage("reseller", got.reason));
  const accessToken = got.token;

  const out: NormalizedSub[] = [];
  let pageToken: string | undefined;
  let skipped = 0;

  try {
    do {
      const url = new URL("https://reseller.googleapis.com/apps/reseller/v1/subscriptions");
      url.searchParams.set("maxResults", probe ? "1" : "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url.toString(), {
        headers: { authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        // API off in the Cloud project / permission missing / token refused → one plain line each.
        const why = classifyGoogleApiError(res.status, txt);
        if (why) return notReady(why, googleReasonMessage("reseller", why), txt.slice(0, 400));
        return NextResponse.json(
          { error: `Reseller API error: ${res.status}`, detail: txt.slice(0, 400) },
          { status: 502 },
        );
      }

      const data = (await res.json()) as ResellerListResponse;
      if (probe) {
        return NextResponse.json({ connected: true, mode: "live" });
      }
      for (const s of data.subscriptions ?? []) {
        const domain = (s.customerDomain ?? "").trim();
        const sku = (s.skuName ?? "").trim();
        if (!domain || !sku || /cloud identity free/i.test(sku)) { skipped++; continue; }
        out.push({
          domain,
          sku,
          seats: Math.max(0, Math.round(s.seats?.numberOfSeats ?? s.seats?.licensedNumberOfSeats ?? 0)),
          status: /active/i.test(s.status ?? "") ? "active" : "paused",
          start_date: msToISO(s.creationTime),
          renewal_date: msToISO(s.plan?.commitmentInterval?.endTime),
        });
      }
      pageToken = data.nextPageToken;
      if (out.length >= 20000) break;   // runaway guard
    } while (pageToken);

    return NextResponse.json({ subscriptions: out, total: out.length, skipped, mode: "live" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "fetch failed" },
      { status: 500 },
    );
  }
}
