/**
 * POST /api/quotes/[id]/recreate-subscription — rebuild a subscription a paid quote lost.
 *
 * ─── WHAT THIS REPAIRS ──────────────────────────────────────────────────────
 * The subscription is what makes a paid deal keep earning: it holds the renewal date, the
 * seats and the MRR, and it is the row the renewal cron chases. Delete it and the money
 * does not stop — it stops being KNOWN. The customer keeps their mailboxes, the reseller
 * keeps paying the vendor, and nothing ever asks for the renewal.
 *
 * ─── IT ONLY EVER ADDS WHAT IS MISSING ──────────────────────────────────────
 * Not a replay of record_payment. That function also takes money, allocates document
 * numbers and raises invoices; re-running it to fix a subscription would be a cure worse
 * than the illness. This touches `subscriptions` and nothing else — no payment row, no
 * invoice, no document number.
 *
 * Which rows are missing is decided by lib/subscriptions/orphan-quote.ts, and it is
 * decided rather than assumed, because record_payment's own conflict guard cannot be
 * borrowed here: `subscriptions_tenant_quote_domain_unique` is PARTIAL —
 * `WHERE quote_id IS NOT NULL AND domain IS NOT NULL` — and a support-plan line carries no
 * domain, so a blind insert would create a second support subscription and invent MRR out
 * of a repair.
 *
 * ─── AND IT REFUSES WHEN THE SUBSCRIPTION IS NOT DUE ────────────────────────
 * An accepted quote with no money against it is SUPPOSED to have no subscription — that is
 * record_payment's job when the money lands. Creating one early would start a renewal
 * clock on a deal nobody has paid for, and would count it in MRR. The same rule the banner
 * uses to stay quiet is the rule this route uses to say no.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { orphanState, isOrphan, missingLines } from "@/lib/subscriptions/orphan-quote";
import { rebuildTerm } from "@/lib/subscriptions/rebuild-term";
import { istToday } from "@/lib/dates/ist";
import { safeDbMessage, logDbError } from "@/lib/errors/db-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface QuoteLineRow {
  name?: string | null;
  qty?: number | null;
  rate?: number | null;
  domain?: string | null;
  item_id?: string | null;
  start_date?: string | null;
  /** Price tier, as stored on the line. Read to tell a 1-month term from a 12-month one. */
  commitment?: string | null;
}

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "Your account is not linked to a workspace yet." }, { status: 403 });
  }
  /* Creating a subscription creates future revenue and a renewal obligation. Owners and
     managers only — the same line middleware.ts draws for the money pages. */
  if (me.role !== "owner" && me.role !== "manager") {
    return NextResponse.json(
      { error: "Only an owner or manager can rebuild a subscription. Ask one of them to open this quote." },
      { status: 403 },
    );
  }

  const admin = createAdminClientFor(user.id);

  /* Scoped by id AND tenant_id: the admin client bypasses RLS, so an id on its own is a
     valid key to any row in the table. */
  const { data: quote } = await admin
    .from("quotes")
    .select("id, tenant_id, status, payment_status, customer_id, customer_name, line_items, is_renewal, is_add_seats, created_date")
    .eq("id", params.id)
    .eq("tenant_id", me.tenant_id)
    .maybeSingle();

  if (!quote) return NextResponse.json({ error: "That quote no longer exists." }, { status: 404 });
  if (!quote.customer_id) {
    /* §24 — name the missing thing and where to fix it. */
    return NextResponse.json(
      { error: "This quote is not linked to a customer yet, so there is nothing to attach a subscription to. Record the payment first — that converts the lead into a customer." },
      { status: 422 },
    );
  }

  const { data: payments } = await admin
    .from("payments").select("amount").eq("quote_id", quote.id).eq("tenant_id", me.tenant_id);
  const received = (payments ?? []).reduce((s, p) => s + (p.amount ?? 0), 0);

  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, plan, domain")
    .eq("quote_id", quote.id)
    .eq("tenant_id", me.tenant_id);

  const lines = Array.isArray(quote.line_items) ? (quote.line_items as QuoteLineRow[]) : [];

  const state = orphanState({
    status:        quote.status,
    paymentStatus: quote.payment_status,
    received,
    isRenewal:     quote.is_renewal,
    isAddSeats:    quote.is_add_seats,
    lines,
    existingSubs:  (subs ?? []).length,
  });

  if (!isOrphan(state)) {
    return NextResponse.json(
      {
        error: state.kind === "not-due"
          ? state.because
          : "Every subscription from this quote already exists — nothing to rebuild.",
      },
      { status: 409 },
    );
  }

  const missing = missingLines(lines, (subs ?? []).map((s) => ({ plan: s.plan, domain: s.domain })));
  if (missing.length === 0) {
    /* Belt and braces: orphanState counts, missingLines matches. If they ever disagree,
       inserting nothing is the safe direction. */
    return NextResponse.json(
      { error: "Nothing could be matched as missing. Open the subscriptions list and check by hand before rebuilding." },
      { status: 409 },
    );
  }

  /* ─── THE VENDOR IS READ FROM THE CATALOGUE, NEVER GUESSED ──────────────────
     `subscriptions.vendor` is a required enum (google | microsoft | zoho | other | domain
     | hosting | support). Inferring it from the plan STRING would work until the day
     somebody renames a SKU, and then a Google seat would be filed under 'other' and drop
     out of the vendor reconciliation that is supposed to catch unpaid licences.

     So it comes from the tenant's own `items` row — by item_id when the line carries one
     (support lines do), otherwise by an exact name match. A line whose vendor cannot be
     resolved is REFUSED below rather than filed under a default. */
  const { data: catalogue } = await admin
    .from("items").select("id, name, vendor").eq("tenant_id", me.tenant_id);

  const byId   = new Map((catalogue ?? []).map((i) => [i.id, i.vendor]));
  const byName = new Map((catalogue ?? []).map((i) => [i.name.trim().toLowerCase(), i.vendor]));
  const vendorFor = (l: QuoteLineRow) =>
    (l.item_id ? byId.get(l.item_id) : undefined)
    ?? byName.get((l.name ?? "").trim().toLowerCase());

  const unresolved = missing.filter((l) => !vendorFor(l));
  if (unresolved.length > 0) {
    /* §24 — names the lines and the fix, rather than filing them under a guess. */
    return NextResponse.json(
      {
        error: `Cannot tell which vendor these belong to: ${unresolved.map((l) => l.name).join(", ")}. Add them to your catalogue (Items) with the right vendor, then rebuild — filing a Google seat under the wrong vendor would hide it from licence reconciliation.`,
      },
      { status: 422 },
    );
  }

  /* The term starts when the deal did, not today. Backdating matters: a subscription paid
     for in April and rebuilt in August must renew next April, not next August — otherwise
     the customer gets four months free and the renewal chase fires late. */
  /* R-025: and this one runs on Cloud Run, which is UTC all the time — so the fallback
     start (and therefore the renewal date derived from it) was a day early whenever the
     request landed before 05:30 IST. */
  const fallbackStart = quote.created_date ?? istToday();
  const customerId = quote.customer_id;

  const rows = missing.map((l) => {
    const start  = (l.start_date ?? fallbackStart).slice(0, 10);
    const seats  = l.qty ?? 0;

    /* Term, MRR and renewal date come from lib/subscriptions/rebuild-term.ts, which exists
       so this route and record_payment cannot drift apart again. They already had: the
       twelfth and the +1 year were hard-coded here, so a monthly subscription rebuilt after
       20260822120000 came back with a tenth of its MRR and a renewal a year away. */
    const { termMonths, mrr, renewalDate } = rebuildTerm({
      commitment: l.commitment, rate: l.rate, qty: seats, startDate: start,
    });

    return {
      tenant_id:     me.tenant_id,
      customer_id:   customerId,
      customer_name: quote.customer_name,
      plan:          (l.name ?? "").trim(),
      vendor:        vendorFor(l)!,
      seats,
      mrr,
      start_date:    start,
      renewal_date:  renewalDate,
      status:        "active" as const,
      /* term_months drives the reminder ladder (lib/renewals/cadence.ts). billing_cycle is
         deliberately NOT set: the trigger subscription_cycle_follows_quote owns it and
         copies it from the quote, and writing it here too would be a second writer. */
      term_months:   termMonths,
      domain:        l.domain ? l.domain.trim() : null,
      item_id:       l.item_id ?? null,
      quote_id:      quote.id,
    };
  });

  const { data: created, error: insErr } = await admin
    .from("subscriptions").insert(rows).select("id, plan, seats, mrr, renewal_date");

  if (insErr) {
    // R-025 — raw Postgres text named the subscriptions table and its constraints.
    logDbError("quotes/recreate-subscription", insErr);
    return NextResponse.json(
      { error: safeDbMessage(insErr, "Could not recreate the subscriptions. Nothing was created — check the quote's line items and try again.") },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    /* Reported in full so the screen can list what it made rather than saying "done" —
       an operator repairing money needs to see the seats and the renewal date. */
    created: created ?? [],
  });
}
