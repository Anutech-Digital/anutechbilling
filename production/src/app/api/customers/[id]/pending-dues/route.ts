/**
 * GET /api/customers/{id}/pending-dues — R-1526 "Send pending dues" preview: what the statement
 * will list, the total, whether it carries a pay QR (and if not, why — §24), and where it can go
 * (the customer's own email / WhatsApp number, or why not). SENDS NOTHING (R-1514).
 *
 *   • Gate: the roles that can open /collections, like Remind (R-1518).
 *   • Read on the caller's session (RLS) with explicit tenant filters; lists page past 1000.
 *   • `pdfLink` is a 7-day signed link to the statement PDF (public route
 *     /api/v1/documents/statement/{id}/pdf — the same HMAC token model as invoice / quote PDFs),
 *     so the WhatsApp text can carry it. It shows the dues as they are WHEN OPENED.
 */
import { z } from "zod";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { trustedOrigin } from "@/lib/app-url";
import { istToday } from "@/lib/dates/ist";
import { pdfDownloadUrl } from "@/lib/pdf/pdf-token";
import { primaryContactFor } from "@/lib/contacts/primary";
import { emailTarget, whatsappTarget } from "@/lib/collections/reminder-draft";
import {
  buildPendingDuesStatement, pendingDuesAbout, pendingDuesEmailText, pendingDuesSubject,
  pendingDuesWhatsappText, statementQrNotice, statementUpiUri, STATEMENT_LINK_TTL_DAYS,
} from "@/lib/collections/pending-dues";
import { loadPendingDuesRaw } from "@/lib/collections/pending-dues.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";


const idSchema = z.string().uuid();

export const GET = withRoute(
  {
    route: "api/customers/pending-dues",
    pages: ["/collections"],
    roleHint: "Your role cannot send pending-dues statements. Ask your manager to give you access to Payment Follow-up.",
  },
  async ({ req, supabase, params, tenantId }) => {
    const customerId = params.id ?? "";
    if (!idSchema.safeParse(customerId).success) throw new RouteError(404, "Customer not found — reload the page and try again.");

    let raw: Awaited<ReturnType<typeof loadPendingDuesRaw>>;
    try {
      raw = await loadPendingDuesRaw(supabase, { customerId, tenantId });
    } catch (e) {
      const detail = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      throw new RouteError(500, "Could not read this customer's bills — reload the page and try again.", detail);
    }
    if (!raw) throw new RouteError(404, "This customer is not in your list any more — reload the page and pick them again.");

    const st = buildPendingDuesStatement(raw, istToday());
    const t = raw.tenant;
    const seller = t?.name?.trim() || "";

    const [contact, legacy] = await Promise.all([
      primaryContactFor(supabase, customerId),
      supabase.from("customers").select("contact_name, contact_email, contact_mobile, contact_phone")
        .eq("id", customerId).eq("tenant_id", tenantId).maybeSingle(),
    ]);
    const l = (legacy.data ?? {}) as { contact_name?: string | null; contact_email?: string | null; contact_mobile?: string | null; contact_phone?: string | null };
    const greetName = contact.name?.trim() || l.contact_name?.trim() || null;
    const wa = whatsappTarget(contact.phone?.trim() || l.contact_mobile?.trim() || l.contact_phone?.trim() || null);
    const em = emailTarget(contact.email?.trim() || l.contact_email?.trim() || null);

    /* No signing key configured → no link (the text simply leaves it out), never a 500. */
    let pdfLink: string | null = null;
    if (st.total > 0) {
      try {
        pdfLink = pdfDownloadUrl(trustedOrigin(req.headers), "statement", customerId, tenantId, { ttlDays: STATEMENT_LINK_TTL_DAYS });
      } catch (e) {
        console.error("[api/customers/pending-dues] statement link not signed:", e instanceof Error ? e.message : e);
      }
    }
    const upiLink = statementUpiUri({
      vpa: t?.upi_vpa, payeeName: t?.upi_payee_name ?? t?.name, customerName: st.customerName, total: st.total, allInr: st.allInr,
    });

    return {
      customerName: st.customerName,
      asOn: st.asOn,
      lines: st.lines,
      total: st.total,
      qrNotice: statementQrNotice({ upiVpa: t?.upi_vpa, allInr: st.allInr, total: st.total }),
      hasBank: !!t?.remit_account_number?.trim(),
      subject: pendingDuesSubject(st, seller),
      emailText: pendingDuesEmailText(st, { greetName, sellerName: seller }),
      whatsappText: pendingDuesWhatsappText(st, { greetName, sellerName: seller, pdfUrl: pdfLink, upiLink }),
      whatsapp: wa.ok ? wa.to : null,
      whatsappBlocked: wa.ok ? null : wa.reason,
      email: em.ok ? em.to : null,
      emailBlocked: em.ok ? null : em.reason,
      about: pendingDuesAbout(st),
    };
  },
);
