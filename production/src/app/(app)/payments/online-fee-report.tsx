/**
 * R-2418 — "Online fee report" on Payments Received, beside "Book Razorpay fees".
 *
 * Owner's question (3 Nov 2026): of the fee Razorpay keeps, how much did customers pay back and
 * how much do we still bear — every month, and for whom (and why). Maths: lib/razorpay/fee-report.ts.
 * Banner: the fee's GST is input credit only when Razorpay's GSTIN is on the vendor master
 * (lib/gst/itc.ts) — without it the credit is blocked, and the button goes to Vendors to add it.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { rupee } from "@/lib/utils";
import { useOnlineFeeReport } from "@/lib/queries/online-fee-report";
import {
  FEE_REASON_LABEL,
  blockedFeeGst,
  buildFeeReport,
  feeGstBlockedText,
} from "@/lib/razorpay/fee-report";
import { FEE_ROLES } from "./gateway-fee";

const VENDORS_HREF = "/accounting/vendors";

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function OnlineFeeReportButton({
  hasFees,
  role,
}: {
  hasFees: boolean;
  role: string | null | undefined;
}) {
  const [open, setOpen] = React.useState(false);
  if (!hasFees || !role || !FEE_ROLES.has(role)) return null;
  return (
    <>
      <Button icon="bar_chart" onClick={() => setOpen(true)} title="Razorpay's fee each month: recovered from customers vs absorbed by us">
        Online fee report
      </Button>
      <OnlineFeeReportSheet open={open} onOpenChange={setOpen} />
    </>
  );
}

function OnlineFeeReportSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const q = useOnlineFeeReport(open);
  const report = React.useMemo(() => (q.data ? buildFeeReport(q.data.rows) : null), [q.data]);
  const blocked = q.data ? blockedFeeGst(q.data.rows, q.data.razorpayGstin) : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[640px] md:max-w-[760px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Online fee report</SheetTitle>
          <SheetDescription>
            Razorpay&apos;s fee (GST included) on online payments — recovered from customers vs absorbed by us.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-5">
          {q.isLoading && <Skeleton className="h-40 w-full" />}
          {q.error && <LoadError what="Online fee report" error={q.error} onRetry={() => { void q.refetch(); }} />}

          {report && (
            <>
              {blocked > 0 && (
                <div role="status" className="flex items-start gap-3 rounded-md border border-amber/60 bg-amber-soft/40 px-3 py-2.5">
                  <Icon name="alert" size={16} className="text-amber-ink mt-0.5 shrink-0" />
                  <div className="flex-1 text-sm text-ink">
                    <b>{feeGstBlockedText(blocked)}</b>
                    <p className="text-xs text-ink-3 mt-0.5">
                      Input credit on the fee needs Razorpay as a vendor with its GSTIN. Until then this GST is a cost.
                    </p>
                  </div>
                  <Button asChild size="sm" variant="primary">
                    <Link href={VENDORS_HREF}>Open Vendors</Link>
                  </Button>
                </div>
              )}

              {q.data && !q.data.policyReady && (
                <p className="text-xs text-ink-3">Fee policy needs a database update — every fee shows as before the policy.</p>
              )}

              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm tabular-nums">
                <div className="rounded-md border border-hairline px-3 py-2">
                  <dt className="text-xs text-ink-3">Razorpay fee</dt>
                  <dd className="font-medium">{rupee(report.totals.fee)}</dd>
                </div>
                <div className="rounded-md border border-hairline px-3 py-2">
                  <dt className="text-xs text-ink-3">Recovered from customers</dt>
                  <dd className="font-medium text-emerald">{rupee(report.totals.recovered)}</dd>
                </div>
                <div className="rounded-md border border-hairline px-3 py-2">
                  <dt className="text-xs text-ink-3">Absorbed by us</dt>
                  <dd className="font-medium text-rose-ink">{rupee(report.totals.absorbed)}</dd>
                </div>
                <div className="rounded-md border border-hairline px-3 py-2">
                  <dt className="text-xs text-ink-3">Payments</dt>
                  <dd className="font-medium">{report.totals.payments}</dd>
                </div>
              </dl>
              {report.totals.surplus > 0 && (
                <p className="text-xs text-ink-3">
                  Customers paid {rupee(report.totals.surplus)} more than Razorpay kept (the fee is grossed up, and its GST is included).
                </p>
              )}

              {report.months.length === 0 ? (
                <p className="text-sm text-ink-3">No online payment carries a Razorpay fee yet.</p>
              ) : (
                <>
                  <section>
                    <h3 className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">By month</h3>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-ink-3 text-left">
                          <th className="py-1 pr-2 font-medium">Month</th>
                          <th className="py-1 pr-2 font-medium text-right">Payments</th>
                          <th className="py-1 pr-2 font-medium text-right">Razorpay fee</th>
                          <th className="py-1 pr-2 font-medium text-right">Recovered</th>
                          <th className="py-1 font-medium text-right">Absorbed by us</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.months.map((m) => (
                          <tr key={m.month} className="border-t border-hairline tabular-nums">
                            <td className="py-1.5 pr-2 text-ink">{monthLabel(m.month)}</td>
                            <td className="py-1.5 pr-2 text-right">{m.payments}</td>
                            <td className="py-1.5 pr-2 text-right">{rupee(m.fee)}</td>
                            <td className="py-1.5 pr-2 text-right">{rupee(m.recovered)}</td>
                            <td className="py-1.5 text-right font-medium">{rupee(m.absorbed)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>

                  <section>
                    <h3 className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">By customer</h3>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-ink-3 text-left">
                          <th className="py-1 pr-2 font-medium">Customer</th>
                          <th className="py-1 pr-2 font-medium">Reason</th>
                          <th className="py-1 pr-2 font-medium text-right">Razorpay fee</th>
                          <th className="py-1 pr-2 font-medium text-right">Recovered</th>
                          <th className="py-1 font-medium text-right">Absorbed by us</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.customers.map((c) => (
                          <tr key={c.key} className="border-t border-hairline align-top tabular-nums">
                            <td className="py-1.5 pr-2 text-ink">
                              {c.customerId ? <Link href={`/customers/${c.customerId}`} className="hover:underline">{c.customerName}</Link> : c.customerName}
                              <span className="text-ink-3"> · {c.payments}</span>
                            </td>
                            <td className="py-1.5 pr-2 text-ink-2">{FEE_REASON_LABEL[c.reason]}</td>
                            <td className="py-1.5 pr-2 text-right">{rupee(c.fee)}</td>
                            <td className="py-1.5 pr-2 text-right">{rupee(c.recovered)}</td>
                            <td className="py-1.5 text-right font-medium">{rupee(c.absorbed)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
