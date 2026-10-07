"use client";

/**
 * Bills that arrived at billing@ and are waiting for a person.
 *
 * ─── THIS SCREEN IS THE "HUMAN MUST CONFIRM" STEP, MADE REAL ────────────────
 * The webhook reads an emailed invoice with Gemini and deliberately posts
 * NOTHING to the books: those figures feed GST input credit and the P&L, an AI
 * can misread a total, and anyone who learns the ingest address could otherwise
 * create entries. Until this queue existed, that rule meant emailed bills simply
 * accumulated in a table nobody could see — the safe behaviour and the useless
 * one at the same time.
 *
 * ─── IT DOES NOT CREATE THE BILL ITSELF ─────────────────────────────────────
 * "Create bill" opens the normal Add Vendor Bill dialog, prefilled. That dialog
 * owns the money rules — currency conversion at an FX rate the operator types,
 * vendor find-or-create, the ₹ integer conversion — and a second copy of them
 * here would drift from the first exactly as a copied prompt does. The queue's
 * job is to carry the extraction over and, afterwards, remember which bill it
 * became.
 *
 * The extracted figures are shown as READ-ONLY text next to a link to the
 * original file, so the operator compares the two before anything is saved.
 */

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/providers/confirm-provider";
import {
  AddVendorBillDialog,
  type VendorBillPrefill,
} from "@/components/features/accounting/add-vendor-bill-dialog";

interface QueueRow {
  id:              string;
  from_email:      string | null;
  subject:         string | null;
  created_at:      string;
  status:          string;
  attachment_name: string | null;
  attachment_path: string | null;
  extracted_bill:  VendorBillPrefill | null;
}

const KEY = ["inbound_bills", "pending"] as const;

function usePendingInboundBills() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<QueueRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("inbound_emails")
        .select("id, from_email, subject, created_at, status, attachment_name, attachment_path, extracted_bill")
        .eq("route", "billing")
        .is("bill_id", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as unknown as QueueRow[];
    },
  });
}

/** Money as the operator reads it — the bill's own currency, decimals kept. */
function money(v: number | null | undefined, currency: string): string {
  if (v == null) return "—";
  return `${currency} ${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function InboundBillsQueue() {
  const { data, isLoading } = usePendingInboundBills();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [openFor, setOpenFor] = React.useState<QueueRow | null>(null);

  /** Remember which bill this email became — closes the queue item for good. */
  const link = useMutation({
    mutationFn: async ({ id, billId }: { id: string; billId: string }) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("inbound_emails")
        .update({ bill_id: billId, status: "bill_created" })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
    onError: (e: Error) => toastError(e, {
      fallback: "Bill saved, but this email is still in the queue.",
      description: "The bill is saved. Press Dismiss on this email so it is not entered twice.",
    }),
  });

  /** Not a bill. Recorded as dismissed, never deleted — the mail still happened. */
  const dismiss = useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("inbound_emails")
        .update({ status: "billing_dismissed" })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Moved out of the queue"); void qc.invalidateQueries({ queryKey: KEY }); },
    onError: (e: Error) => toastError(e, {
      fallback: "Could not move this email out of the queue.",
      description: "Nothing was deleted. Refresh the page and press Dismiss again.",
    }),
  });

  async function openAttachment(path: string | null) {
    if (!path) { toast.error("The original file was not stored for this one.", { description: "Open the email in your inbox to see the attachment." }); return; }
    const supabase = createClient();
    // The bucket is private, so a short-lived signed URL — never a public link
    // to a vendor invoice.
    const { data: signed, error } = await supabase.storage.from("documents").createSignedUrl(path, 300);
    if (error || !signed?.signedUrl) { toast.error("Could not open the file.", { description: "The download link could not be made. Refresh the page and try again." }); return; }
    window.open(signed.signedUrl, "_blank", "noopener,noreferrer");
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />;

  const rows = (data ?? []).filter((r) => r.status !== "billing_dismissed");
  // Silent when there is nothing waiting — this is a queue, not a dashboard.
  if (rows.length === 0) return null;

  return (
    <>
      <Card className="mb-4 border-amber/40">
        <div className="mb-3 flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-soft">
            <Icon name="inbox" size={16} className="text-amber-ink" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-ink">
              {rows.length === 1 ? "1 bill arrived by email" : `${rows.length} bills arrived by email`}
            </h3>
            <p className="text-xs text-ink-3 leading-relaxed">
              Read automatically, <b>not saved</b>. Open the file, check the figures against it,
              then create the bill — nothing reaches your books until you do.
            </p>
          </div>
        </div>

        <ul className="space-y-2">
          {rows.map((r) => {
            const f   = r.extracted_bill;
            const cur = String(f?.currency ?? "INR") || "INR";
            return (
              <li key={r.id} className="rounded-md border border-hairline p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm text-ink truncate">
                      {f?.vendor_name || r.subject || "(no subject)"}
                    </div>
                    <div className="text-xs text-ink-3 font-mono truncate">
                      {r.from_email} · {new Date(r.created_at).toLocaleDateString("en-IN")}
                    </div>

                    {f ? (
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-2">
                        <span>Bill no: <b>{f.bill_no || "—"}</b></span>
                        <span>Date: <b>{f.bill_date || "—"}</b></span>
                        <span>Subtotal: <b>{money(f.subtotal, cur)}</b></span>
                        <span>Tax: <b>{money((f.cgst ?? 0) + (f.sgst ?? 0) + (f.igst ?? 0), cur)}</b></span>
                        <span>Total: <b>{money(f.total, cur)}</b></span>
                        {cur !== "INR" && <Badge kind="warning" size="sm">You&apos;ll enter today&apos;s ₹ rate</Badge>}
                      </div>
                    ) : (
                      <div className="mt-1.5 text-xs text-amber-ink">
                        Could not be read automatically — open the file and enter it by hand.
                      </div>
                    )}
                  </div>

                  <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
                    <Button variant="outline" className="h-8 px-2 text-[12px]"
                      onClick={() => openAttachment(r.attachment_path)}>
                      {r.attachment_name ? "Open file" : "No file"}
                    </Button>
                    <Button variant="primary" className="h-8 px-2 text-[12px]"
                      onClick={() => setOpenFor(r)}>
                      Create bill
                    </Button>
                    <Button variant="ghost" className="h-8 px-2 text-[12px]"
                      onClick={async () => {
                        if (await confirm({
                          title: "Not a bill?",
                          body: "It stays in the inbound log — this only takes it out of the queue.",
                          confirmLabel: "Move out",
                        })) dismiss.mutate(r.id);
                      }}>
                      Not a bill
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {openFor && (
        <AddVendorBillDialog
          prefill={openFor.extracted_bill ?? undefined}
          onCreated={(billId) => link.mutate({ id: openFor.id, billId })}
          onClose={() => setOpenFor(null)}
        />
      )}
    </>
  );
}
