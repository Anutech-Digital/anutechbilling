/**
 * POST /api/enquiry — the bridge between this website and ResellerOS.
 *
 * The quote and trial forms post HERE. This route maps the form onto the app's public
 * enquiry contract and hands it to the app's own handler.
 *
 * ─── R-1598 (18 Oct 2026): IN THIS DEPLOYMENT, NOT OVER THE INTERNET ─────────
 * It used to call the app's public API over the internet at the site config's app URL, which
 * defaulted to the LIVE domain because no build passed that variable — so staging's /quote
 * and /trial leads landed in the live app, and the rebuilt payload dropped pageUrl and the
 * Referer, so every one of them lost its gclid/utm. Website and app are one Next service now:
 * the handler is called in-process (site/lib/app-forward.ts) with the visitor's headers and
 * the page URL. A cross-origin hop only happens when the server-side RESELLEROS_FORWARD_URL
 * names one, and never from a non-production host into production.
 *
 * ─── TWO PATHS, PICKED BY WHAT WAS ASKED FOR ────────────────────────────────
 * A Google Workspace edition (Starter/Standard/Plus) goes to
 * `/api/public/enquiry/workspace` — the AUTO-QUOTE path. That endpoint creates the lead
 * AND a catalog-priced draft quotation (the same pricing module the app's checkout uses),
 * alerts the operator with a deep-link to it, and acknowledges the customer. Its
 * `draftQuoteId` comes back through us so the form can name the document.
 *
 * R-228: every success also carries `reference` — the draft quote's number, else the lead id
 * (both paths return `leadId`), else null. The forms show THAT, never a number of their own:
 * a per-browser localStorage counter started every new visitor at AQ-YYYYMM-001, which sales
 * could not match to anything in the app.
 *
 * Everything else (M365, Zoho, Anutech Mail, Hosting, Domains) goes to
 * `/api/public/enquiry/general` — lead + notification, priced by a person. The app has no
 * auto-quote path for those vendors yet, and inventing one here would mean website-side
 * price arithmetic, which is exactly what this design avoids.
 *
 * ─── FIELD NAMES COME FROM THE APP'S SOURCE, NOT FROM MEMORY ────────────────
 * Pardeep's first real submit failed with 400 "Invalid form data: Required" because this
 * proxy sent `requirement` where the app's Zod says `message` — a field name I had
 * GUESSED after reading only the schema's first 50 lines, with a test that pinned my own
 * guess. Both schemas are now read IN FULL and site-invariants.test.ts checks this proxy
 * against the app's actual route sources; if the app's contract changes shape, the suite
 * goes red instead of visitors getting silent 400s.
 */
import { NextResponse, type NextRequest } from "next/server";
import { gwTierFor } from "@/site/lib/quote-mapping";
import { deliverToApp, pageField } from "@/site/lib/app-forward";
import { POST as generalEnquiry } from "@/app/api/public/enquiry/general/route";
import { POST as workspaceEnquiry } from "@/app/api/public/enquiry/workspace/route";
import { siteVisitorLimit, waitPhrase } from "@/lib/security/rate-limit";
import { redactContacts } from "@/lib/security/redact-contact";

/** The app's two public enquiry endpoints — handled by this deployment (R-1598). */
const ENQUIRY_API = "/api/public/enquiry/general";
const ENQUIRY_WORKSPACE_API = "/api/public/enquiry/workspace";

interface EnquiryBody {
  fullName: string;
  companyName: string;
  email: string;
  phone: string;
  product?: "google-workspace" | "microsoft-365" | "zoho" | "other";
  seats?: number;
  requirement?: string;
  /** The exact edition chip the visitor chose — decides the path. */
  edition?: string;
  /** annual | monthly — the workspace endpoint's `billing`. */
  term?: string;
  /** Sent by the trial form: the app then emails the customer but not the owner. */
  trial?: boolean;
  /** The landing page (with ?gclid / utm_*) and where the visitor came from — attribution. */
  pageUrl?: string;
  pageReferrer?: string;
}

const PRODUCTS = new Set(["google-workspace", "microsoft-365", "zoho", "other"]);

/** R-1549 / §24: the bot check refused it — say nothing was saved, and how to get past it. */
function botCheckFailed() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "We could not confirm this request came from a person, so nothing was saved. " +
        "Reload the page and press the button again — if it keeps happening, message us on WhatsApp.",
    },
    { status: 403 },
  );
}

/** An id the app returned, trimmed; null when it sent none. */
function idOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export async function POST(req: NextRequest) {
  let body: Partial<EnquiryBody>;
  try {
    body = (await req.json()) as Partial<EnquiryBody>;
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request." }, { status: 400 });
  }

  const fullName = String(body.fullName ?? "").trim();
  const companyName = String(body.companyName ?? "").trim();
  const email = String(body.email ?? "").trim();
  const phone = String(body.phone ?? "").trim();

  if (fullName.length < 2 || companyName.length < 2 || !email.includes("@") || phone.length < 10) {
    return NextResponse.json(
      { ok: false, error: "Name, company, a valid email and a 10-digit phone are required." },
      { status: 400 },
    );
  }

  /* R-1549: this visitor's own count — per IP, and per email — never one bucket for everyone.
     The middleware does not count this path, and the handler below runs in-process. */
  const limit = await siteVisitorLimit("enquiry", req.headers, email);
  if (!limit.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `Too many requests were sent from your connection or email in a short time, so this one was not sent — nothing was saved. ` +
          `Please wait ${waitPhrase(limit.retryAfterSec)} and press the button again, or message us on WhatsApp.`,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const seats =
    Number.isFinite(body.seats) && (body.seats as number) >= 1 ? Math.floor(body.seats as number) : null;
  const message =
    typeof body.requirement === "string" && body.requirement.trim()
      ? body.requirement.trim().slice(0, 2000)
      : "Quote request from the website form.";

  const tier = typeof body.edition === "string" ? gwTierFor(body.edition) : null;
  const trial = body.trial === true;

  const fail = () =>
    NextResponse.json(
      { ok: false, error: "We could not record your request just now, so nothing was saved. Please try again in a moment." },
      { status: 502 },
    );

  /* R-1598: where the visitor landed (gclid/utm) and came from — the lead handlers store them
     (captureFromRequest). Without them every /quote and /trial lead read "direct". */
  const attribution: Record<string, string> = {};
  const pageUrl = pageField(body.pageUrl);
  const pageReferrer = pageField(body.pageReferrer);
  if (pageUrl) attribution.pageUrl = pageUrl;
  if (pageReferrer) attribution.pageReferrer = pageReferrer;

  /* R-020: the visitor's Turnstile token (with Referer and IP) travels in the passed-through
     headers to the ONE handler call below — a token works once, never two calls with it. */
  const post = (path: string, local: typeof generalEnquiry, payload: Record<string, unknown>) =>
    deliverToApp({ req, path, local, payload: { ...payload, ...attribution }, timeoutMs: 10_000, tag: "enquiry" });

  try {
    /* ── AUTO-QUOTE PATH: a GW edition with a seat count ──────────────────────
       The workspace endpoint REQUIRES seats and tierId; if either is missing the general
       path still records the lead — a degraded enquiry beats a rejected one. */
    if (tier && seats) {
      const res = await post(ENQUIRY_WORKSPACE_API, workspaceEnquiry, {
        fullName,
        companyName,
        email,
        phone,
        seats,
        tierId: tier,
        billing: body.term === "monthly" ? "monthly" : "annual",
        message,
        ...(trial ? { trial: true } : {}),
      });
      if (res.status === 403) return botCheckFailed();
      if (!res.ok) {
        console.error("[enquiry] workspace handler refused:", res.status, redactContacts(await res.text().catch(() => "")));
        return fail();
      }
      const data = (await res.json()) as { success?: boolean; leadId?: string | null; draftQuoteId?: string | null; autoSent?: boolean; ackSent?: boolean };
      /* draftQuoteId can be null (doc-number retries exhausted) — the lead still exists
         and the operator was alerted, so that is a success with no number to show. */
      const quoteId = idOrNull(data.draftQuoteId);
      const leadId = idOrNull(data.leadId);
      return NextResponse.json({ ok: true, quoteId, leadId, reference: quoteId ?? leadId, sent: data.autoSent === true, ackSent: data.ackSent === true });
    }

    /* ── GENERAL PATH: everything else ────────────────────────────────────── */
    const payload: Record<string, unknown> = { fullName, companyName, email, phone, message };
    if (typeof body.product === "string" && PRODUCTS.has(body.product)) payload.product = body.product;
    if (seats) payload.seats = seats;
    if (trial) payload.trial = true;

    const res = await post(ENQUIRY_API, generalEnquiry, payload);
    if (res.status === 403) return botCheckFailed();
    if (!res.ok) {
      console.error("[enquiry] general handler refused:", res.status, redactContacts(await res.text().catch(() => "")));
      return fail();
    }
    const general = (await res.json().catch(() => ({}))) as { leadId?: string | null; ackSent?: boolean };
    const leadId = idOrNull(general.leadId);
    return NextResponse.json({ ok: true, quoteId: null, leadId, reference: leadId, sent: false, ackSent: general.ackSent === true });
  } catch (err) {
    console.error("[enquiry] handler failed:", err);
    return fail();
  }
}
