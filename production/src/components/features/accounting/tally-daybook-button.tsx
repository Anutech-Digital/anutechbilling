"use client";

/**
 * "Tally day book" — every Sales, Receipt and Payment voucher of the chosen period, in one
 * Tally XML (S34). The party khata's own "Tally XML" button stays for one customer/vendor.
 *
 * Reads through the browser client, so RLS scopes every query to this company — no tenant_id
 * is passed by hand. The whole build is lib/accounting/tally-vouchers.ts (tested); this file
 * only fetches and downloads.
 */
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import type { LedgerPeriod } from "@/lib/accounting/ledger";
import {
  tallyVouchersXml, salesFromInvoices, receiptsFromPayments, paymentsFromBills,
  type InvoiceForTally, type PaymentForTally, type BillForTally,
} from "@/lib/accounting/tally-vouchers";
import { logExport } from "@/lib/export-log";
import { onlySaleInvoices } from "@/lib/accounting/sale-documents";

interface TallyDaybookButtonProps {
  period: LedgerPeriod;
  companyName: string;
}

export default function TallyDaybookButton({ period, companyName }: TallyDaybookButtonProps) {
  const [busy, setBusy] = React.useState(false);

  const onClick = async () => {
    setBusy(true);
    try {
      const supabase = createClient();
      const toTs = `${period.to}T23:59:59.999+05:30`;
      const fromTs = `${period.from}T00:00:00+05:30`;
      const [inv, pay, exp] = await Promise.all([
        /* R-1739: an invoice imported from Zoho Books is no Sales voucher (it is in Zoho / Tally already). */
        onlySaleInvoices(supabase.from("invoices")
          .select("id, customer_name, invoice_date, status, amount, taxable_value, tax_amount, inter_state"))
          .gte("invoice_date", period.from).lte("invoice_date", period.to),
        supabase.from("payments")
          .select("id, receipt_voucher_no, customer_id, amount, credit_applied, received_at, method, reference")
          .gte("received_at", fromTs).lte("received_at", toTs),
        supabase.from("expenses")
          .select("id, vendor_name, bill_no, amount, paid, paid_date, payment_method, category")
          .eq("paid", true).gte("paid_date", period.from).lte("paid_date", period.to),
      ]);
      if (inv.error) throw inv.error;
      if (pay.error) throw pay.error;
      if (exp.error) throw exp.error;

      const customerIds = [...new Set((pay.data ?? []).map((p) => p.customer_id).filter((x): x is string => !!x))];
      const names = new Map<string, string>();
      if (customerIds.length) {
        const { data: cs, error } = await supabase.from("customers").select("id, name").in("id", customerIds);
        if (error) throw error;
        for (const c of cs ?? []) names.set(c.id, c.name);
      }

      const s = salesFromInvoices((inv.data ?? []) as InvoiceForTally[], period.from, period.to);
      const r = receiptsFromPayments((pay.data ?? []) as PaymentForTally[], names, period.from, period.to);
      const p = paymentsFromBills((exp.data ?? []) as BillForTally[], period.from, period.to);
      const xml = tallyVouchersXml({ company: companyName, sales: s.sales, receipts: r.receipts, payments: p.payments });

      const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tally-daybook-${period.label.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.xml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      void logExport({ what: "tally-daybook", rowCount: s.sales.length + r.receipts.length + p.payments.length, format: "xml" });

      const skipped = s.skipped.length + r.skipped.length + p.skipped.length;
      toast.success(`Tally day book: ${s.sales.length} sales · ${r.receipts.length} receipts · ${p.payments.length} payments`, {
        description:
          (skipped ? `${skipped} entr${skipped === 1 ? "y" : "ies"} left out (no GST breakdown or no party) — enter those in Tally by hand. ` : "")
          + "Import: Gateway of Tally → Import Data → Vouchers. Ledgers Sales, Output CGST/SGST/IGST, Round Off, Bank and every party must already exist in Tally.",
      });
    } catch (e) {
      toast.error("Could not create the Tally day book", {
        description: `${e instanceof Error ? e.message : "Unknown error"} — refresh the page and try again; if it still fails, try a shorter period.`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size="sm" variant="outline" icon="upload" onClick={onClick} disabled={busy}>
      {busy ? "Creating…" : "Tally day book"}
    </Button>
  );
}
