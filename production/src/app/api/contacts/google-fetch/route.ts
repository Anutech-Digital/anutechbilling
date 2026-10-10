/**
 * GET /api/contacts/google-fetch
 *
 * Fetches contacts from the signed-in user's Google account via the People API.
 * Token: getGoogleAccessToken("contacts") — saved connection, else the sign-in session (R-824).
 *
 * Setup required:
 *   1. Supabase Dashboard → Auth → Providers → Google → enable + add scope:
 *      https://www.googleapis.com/auth/contacts.readonly
 *   2. Google Cloud Console → OAuth consent screen → include same scope
 *
 * If the user hasn't granted the contacts scope yet, returns 403 with
 * `code: 'needs_reauth'` so the UI can trigger a re-auth flow with the
 * additional scope.
 *
 * Returns: { contacts: ParsedContact[], totalConnections, mode }
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CONTACT_IMPORT_RETIRED, contactImportRetired } from "@/lib/contacts/retired";
import { classifyGoogleApiError, getGoogleAccessToken, googleReasonMessage } from "@/server/auth/google-token";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PeopleApiPerson {
  resourceName?:   string;
  names?:          Array<{ displayName?: string; givenName?: string; familyName?: string }>;
  emailAddresses?: Array<{ value?: string; type?: string }>;
  phoneNumbers?:   Array<{ value?: string; type?: string }>;
  organizations?:  Array<{ name?: string; title?: string }>;
  biographies?:    Array<{ value?: string }>;
}

interface PeopleApiResponse {
  connections?:        PeopleApiPerson[];
  totalPeople?:        number;
  nextPageToken?:      string;
  nextSyncToken?:      string;
}

export interface FetchedContact {
  resourceName: string;
  fullName:     string;
  email:        string | null;
  phone:        string | null;
  company:      string | null;
  title:        string | null;
  notes:        string | null;
}

function normalizePerson(p: PeopleApiPerson): FetchedContact | null {
  const name = p.names?.[0]?.displayName
    || [p.names?.[0]?.givenName, p.names?.[0]?.familyName].filter(Boolean).join(" ").trim()
    || p.emailAddresses?.[0]?.value?.split("@")[0].replace(/[._-]+/g, " ");
  if (!name) return null;
  return {
    resourceName: p.resourceName ?? "",
    fullName:     name,
    email:        p.emailAddresses?.[0]?.value?.toLowerCase() ?? null,
    phone:        p.phoneNumbers?.[0]?.value ?? null,
    company:      p.organizations?.[0]?.name ?? null,
    title:        p.organizations?.[0]?.title ?? null,
    notes:        p.biographies?.[0]?.value ?? null,
  };
}

export async function GET() {
  /* RETIRED 10 Sep 2026 — see lib/contacts/retired.ts. `contacts` is now only a
     customer's people; anybody who is not a customer yet is a LEAD. Fails closed, so
     no new address-book row can be written whatever still calls this. */
  if (CONTACT_IMPORT_RETIRED) return contactImportRetired();

  const supabase = createClient();
  /* Pehchan getUser() se — wo JWT ko SERVER par verify karta hai (audit C8). Google ka
     token getGoogleAccessToken() server par hi dhoondta hai (R-824, R-528). */
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const got = await getGoogleAccessToken("contacts", user.id);
  if (!got.ok) {
    return NextResponse.json({ error: googleReasonMessage("contacts", got.reason), code: got.reason }, { status: 403 });
  }
  const accessToken = got.token;

  // ── Paginated fetch from People API ─────────────────────────────
  const all: FetchedContact[] = [];
  let pageToken: string | undefined;
  let totalConnections = 0;

  try {
    do {
      const url = new URL("https://people.googleapis.com/v1/people/me/connections");
      url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers,organizations,biographies");
      url.searchParams.set("pageSize", "200");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url.toString(), {
        headers: { authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 401 || res.status === 403) {
        const txt = await res.text().catch(() => "");
        // Token refused, permission missing, or the People API is off.
        const why = classifyGoogleApiError(res.status, txt) ?? "needs_reauth";
        return NextResponse.json(
          { error: googleReasonMessage("contacts", why), code: why, detail: txt.slice(0, 300) },
          { status: 403 },
        );
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return NextResponse.json(
          { error: `Google API error: ${res.status}`, detail: txt.slice(0, 300) },
          { status: 502 },
        );
      }

      const data = (await res.json()) as PeopleApiResponse;
      totalConnections = data.totalPeople ?? totalConnections;
      for (const conn of data.connections ?? []) {
        const norm = normalizePerson(conn);
        if (norm) all.push(norm);
      }
      pageToken = data.nextPageToken;
      // safety: cap at 5000 to prevent runaway loops on huge contact lists
      if (all.length >= 5000) break;
    } while (pageToken);

    return NextResponse.json({
      contacts:         all,
      totalConnections: totalConnections || all.length,
      mode:             "live",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "fetch failed" },
      { status: 500 },
    );
  }
}
