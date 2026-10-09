/**
 * POST /api/public/quote/[id]/accept
 *
 * Customer-side action: marks the quote as accepted + sets payment_status to awaiting.
 * Uses admin client (bypasses RLS) since the customer isn't authenticated.
 * Quote ID is the implicit secret.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";
import { isQuoteExpired, rupee } from "@/lib/utils";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { sendEmail } from "@/lib/email/send";
import { buildSalesAcknowledgementHtml } from "@/lib/email/quote-template";
import { configureQuote, describeChanges, type LineChoice } from "@/lib/quotes/configure";
import { grossAmount } from "@/lib/quotes/amounts";
import type { QuoteLineItem, Item } from "@/lib/supabase/database.types";
import { publicDbError } from "@/app/api/public/_lib/db-error";
import { clientIp } from "@/lib/security/rate-limit";

/** Accepts only the three fields a choice may carry — anything else is dropped. */
function parseChoices(raw: unknown): LineChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: LineChoice[] = [];
  for (const entry of raw.slice(0, 100)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.lineId !== "string") continue;
    out.push({
      lineId: e.lineId,
      seats: typeof e.seats === "number" ? e.seats : undefined,
      included: typeof e.included === "boolean" ? e.included : undefined,
    });
  }
  return out;
}

/* R-020: the signer's IP comes from the shared clientIp (lib/security/rate-limit), which
   reads x-forwarded-for from the RIGHT, skipping only our own trusted proxy hops. This
   file used to take the FIRST entry — the one the client writes — so anyone could put any
   address on the acceptance record. */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createAdminClient();

  // 1. Fetch the quote to validate state + authorize the caller by token
  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select("id, status, payment_status, expires_date, customer_name, tenant_id, public_token, amount, line_items, tax_rate, subtotal")
    .eq("id", params.id)
    .maybeSingle();

  if (qErr || !quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  // Authorization: the link carries an unguessable ?t=<token> (SEC-1). Without a
  // matching token we behave exactly like "not found" — no enumeration signal.
  const token = request.nextUrl.searchParams.get("t");
  if (!quoteTokenMatches(token, quote.public_token)) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  // 2. Reject drafts / already-accepted / rejected / expired
  if (quote.status === "draft") {
    return NextResponse.json({ error: "This quote hasn't been sent yet" }, { status: 400 });
  }
  if (quote.status === "accepted") {
    return NextResponse.json({ ok: true, already: true });
  }
  if (quote.status === "rejected") {
    return NextResponse.json({ error: "This quote was rejected — please reach out to the reseller" }, { status: 400 });
  }
  /* R-448: 'expired' is also a replaced quote (superseded_by) — it can't be accepted. */
  if (quote.status === "expired") {
    return NextResponse.json({ error: "This quote is closed or was replaced — please ask the reseller for the latest one" }, { status: 400 });
  }
  // Expiry judged at END OF DAY IST — a quote "valid until 30 Jun" must accept
  // through all of 30 Jun in India, not lapse at 05:30 IST (UTC midnight). (#20)
  if (isQuoteExpired(quote.expires_date)) {
    return NextResponse.json({ error: "This quote has expired — please ask the reseller for a fresh one" }, { status: 400 });
  }

  // 2b. The customer's configuration, re-priced HERE. The body carries a shape
  //     ({lineId, seats, included}) and a signature — never a price. See
  //     lib/quotes/configure.ts.
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* no body is fine */ }

  const choices = parseChoices(body.choices);
  const { data: catalogRows } = await supabase
    .from("items").select("*").eq("tenant_id", quote.tenant_id).eq("is_active", true);

  const configured = configureQuote(
    (quote.line_items ?? []) as QuoteLineItem[],
    choices,
    (catalogRows ?? []) as Item[],
  );

  /* A customer must not be able to self-accept into a deal the reseller's own approval
     rules would have stopped. When their change needs sign-off, this is a CHANGE
     REQUEST: nothing is accepted, the quote is untouched, and the reseller is told what
     was asked for. Returning 200 with accepted:false rather than an error, because the
     customer did nothing wrong — the answer is "we will come back to you". */
  if (configured.changed && !configured.selfAcceptable) {
    const changes = describeChanges(configured);
    try {
      const { data: tenant } = await supabase
        .from("tenants").select("name, email").eq("id", quote.tenant_id).single();
      if (tenant?.email) {
        await sendEmail({
          /* Bina `route` ke ye default Resend par jata hai (send.ts:26), aur wo test mode
                me hai. Tenant ne Gmail chuna hai to mail wahi se jaye. */
          route: { tenantId: quote.tenant_id },
          to: tenant.email,
          subject: `Change requested on quote ${params.id} by ${quote.customer_name}`,
          text:
            `${quote.customer_name} reconfigured quote ${params.id} on the online quote page.\n\n` +
            `${changes.join("\n")}\n\n` +
            `New total would be ${rupee(grossAmount(configured.subtotal, quote.tax_rate ?? 18))}.\n\n` +
            `It was NOT accepted — the new pricing needs ${configured.approval.tier === "owner" ? "owner" : "manager"} approval:\n` +
            `${configured.approval.reasons.join("\n")}\n\n` +
            `Open the quote to approve the new figures or call the customer.`,
        });
      }
    } catch (mailErr) {
      console.error(`[quote-accept] change-request email failed for ${params.id}:`, mailErr);
    }

    return NextResponse.json({
      ok: true,
      accepted: false,
      changeRequested: true,
      message: "Your changes have been sent to the reseller — they will confirm the new pricing with you.",
    });
  }

  /* An acceptable change is written to the quote BEFORE accepting, so accept_quote and
     everything downstream (subscription seats, invoice amount) see what the customer
     actually agreed to rather than the original shape. */
  if (configured.changed) {
    const newLines: QuoteLineItem[] = configured.lines
      .filter((l) => l.included)
      .map((l) => ({ ...l.line, qty: l.qty, rate: l.rate, cost: l.cost }));
    const newSubtotal = configured.subtotal;
    const { error: reshapeErr } = await supabase
      .from("quotes")
      .update({
        line_items: newLines,
        subtotal: newSubtotal,
        total_cost: configured.economics.totalCost,
        amount: grossAmount(newSubtotal, quote.tax_rate ?? 18),
        seats: newLines.reduce((s, l) => s + l.qty, 0),
      })
      .eq("id", params.id);
    if (reshapeErr) {
      const e = publicDbError("quote/accept", reshapeErr, "We could not update your quote just now. Please try again in a minute.");
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
  }

  // 2c. The click-to-sign acknowledgement, when the page collected one.
  //     Recorded BEFORE accept_quote so a signature is never lost to a later failure —
  //     an unmatched signature is recoverable, an accepted quote with no record of who
  //     agreed is not.
  const signerName = typeof body.signerName === "string" ? body.signerName.trim().slice(0, 200) : "";
  if (signerName) {
    const total = grossAmount(configured.subtotal, quote.tax_rate ?? 18);
    const { error: sigErr } = await supabase.from("quote_signatures").insert({
      tenant_id: quote.tenant_id,
      quote_id: params.id,
      signer_name: signerName,
      signer_email: typeof body.signerEmail === "string" ? body.signerEmail.trim().slice(0, 320) : null,
      signer_title: typeof body.signerTitle === "string" ? body.signerTitle.trim().slice(0, 200) : null,
      signer_ip: clientIp(request.headers),
      user_agent: request.headers.get("user-agent")?.slice(0, 1000) ?? null,
      /* The figures AS SHOWN. A signature pointing at a mutable row proves nothing. */
      signed_snapshot: {
        subtotal: configured.subtotal,
        total,
        changed: configured.changed,
        lines: configured.lines
          .filter((l) => l.included)
          .map((l) => ({ name: l.line.name, qty: l.qty, rate: l.rate })),
      },
    });
    if (sigErr) {
      console.error(`[quote-accept] signature insert failed for ${params.id}:`, sigErr);
    }
  }

  // 3. Accept + convert the linked lead → customer atomically via accept_quote
  //    (migration 0059 made the RPC service-role safe — it derives the tenant
  //    from the quote when there's no auth context). This is the SAME path the
  //    operator's "Mark accepted" uses, so a customer self-accept now also
  //    creates the customer record, advances the lead to 'won', and sets
  //    payment_status='awaiting' — instead of only flipping the quote status
  //    and leaving the deal un-converted until payment landed (#17).
  const { error: acceptErr } = await supabase.rpc("accept_quote", {
    p_quote_id: params.id,
  });

  if (acceptErr) {
    /* accept_quote's own messages are written for staff ("quote … does not belong to your
       tenant"), so none of them is passed to the customer (R-026). */
    const e = publicDbError("quote/accept", acceptErr, "We could not accept this quote just now. Please refresh the page and try again.");
    return NextResponse.json({ error: e.message }, { status: e.status });
  }

  // 4. Send Sales Team Acknowledgement Notification Email to Reseller / Sales Exec
  try {
    const { data: tenant } = await supabase
      .from("tenants")
      .select("name, email")
      .eq("id", quote.tenant_id)
      .single();

    if (tenant?.email) {
      const ackHtml = buildSalesAcknowledgementHtml({
        quoteId: params.id,
        customerName: quote.customer_name,
        tenantName: tenant.name,
        totalAmount: quote.amount ?? 0,
        acceptedAt: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      });

      await sendEmail({
        /* Bina `route` ke ye default Resend par jata hai (send.ts:26), aur wo test mode
              me hai. Tenant ne Gmail chuna hai to mail wahi se jaye. */
        route: { tenantId: quote.tenant_id },
        to: tenant.email,
        subject: `🎉 Sales Alert: Quotation #${params.id} Accepted by ${quote.customer_name}`,
        text: `Customer ${quote.customer_name} accepted quotation #${params.id} for ${rupee(quote.amount ?? 0)}. Lead converted to Won customer & PO/Invoice drafts created.`,
        html: ackHtml,
      });
    }
  } catch (emailErr) {
    console.error(`[quote-accept] Failed sending sales acknowledgement email for ${params.id}:`, emailErr);
  }

  console.info(`[quote-accept] ${params.id} accepted by ${quote.customer_name} (tenant ${quote.tenant_id})`);

  /* In-app khabar (audit B4) — accept COMMIT ke baad, best-effort. */
  await notifyTenantOwners({
    tenantId: quote.tenant_id,
    kind: "quote.accepted",
    title: `Quote accepted — ${quote.id}`,
    body: `${quote.customer_name}${signerName ? ` · signed by ${signerName}` : ""}`,
    href: `/quotes/${quote.id}`,
    entityId: quote.id,
  });

  return NextResponse.json({ ok: true, accepted: true, signed: Boolean(signerName) });
}
