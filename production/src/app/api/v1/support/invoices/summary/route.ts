/**
 * GET /api/v1/support/invoices/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * R-2079 — support revenue from Billing's GST tax invoices, for DSP's revenue report. API-key
 * auth (scope "read"), tenant-scoped: every read carries the key's tenant itself, because
 * this runs on the admin client and RLS does not protect it.
 *
 * Only issued Tax Invoices (pending / paid / overdue — no draft, no void, no Bill of Supply,
 * no Zoho opening invoice) with support lines (SUP-…), only their support share, less the
 * credit notes raised against them in the period. Dates are IST calendar dates, both ends
 * included. Amounts in rupees, exact to the paisa. Rules: lib/support/invoice-summary.ts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/api-keys/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { badRequest, requireScope, serverError, unauthorized } from "@/lib/api/v1-response";
import { onlySaleInvoices } from "@/lib/accounting/sale-documents";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import {
  ISSUED_INVOICE_STATUSES,
  parseSummaryRange,
  summariseSupportInvoices,
  type SummaryCreditNote,
  type SummaryInvoice,
} from "@/lib/support/invoice-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVOICE_COLS = "id, invoice_date, status, document_kind, amount, taxable_value, tax_amount, line_items";

export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return unauthorized();
  const denied = requireScope(auth, "read");
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const range = parseSummaryRange(sp.get("from"), sp.get("to"));
  if ("error" in range) return badRequest(range.error);

  const admin = createAdminClient();
  try {
    const [invoices, creditNotes] = await Promise.all([
      fetchAllRows<SummaryInvoice>((from, to) => onlySaleInvoices(admin
        .from("invoices")
        .select(INVOICE_COLS))
        .eq("tenant_id", auth.tenantId)
        .eq("document_kind", "tax_invoice")
        .in("status", [...ISSUED_INVOICE_STATUSES])
        .gte("invoice_date", range.from)
        .lte("invoice_date", range.to)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: SummaryInvoice[] | null; error: unknown }>),
      fetchAllRows<SummaryCreditNote>((from, to) => admin
        .from("credit_notes")
        .select("id, invoice_id, credit_date, amount, taxable_value, tax_amount")
        .eq("tenant_id", auth.tenantId)
        .gte("credit_date", range.from)
        .lte("credit_date", range.to)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: SummaryCreditNote[] | null; error: unknown }>),
    ]);

    /* A credit note may amend an invoice from before the period: read its parent too
       (same tenant, same issued-Tax-Invoice rules, re-checked in the summariser). */
    const inPeriod = new Set(invoices.map((i) => i.id));
    const parentIds = creditNotes.map((n) => n.invoice_id).filter((x): x is string => !!x && !inPeriod.has(x));
    const older = await fetchAllRowsIn<SummaryInvoice, string>(parentIds, (run, from, to) => onlySaleInvoices(admin
      .from("invoices")
      .select(INVOICE_COLS))
      .eq("tenant_id", auth.tenantId)
      .in("id", run)
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: SummaryInvoice[] | null; error: unknown }>);

    return NextResponse.json(summariseSupportInvoices({
      from: range.from,
      to: range.to,
      invoices,
      creditNotes,
      parents: [...invoices, ...older],
    }));
  } catch {
    return serverError("Could not load support invoices just now. Try again in a minute.");
  }
}
