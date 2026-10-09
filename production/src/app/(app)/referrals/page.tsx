/**
 * Referrals — manage referral partners + commissions.
 *
 * Two views:
 *   • Commissions — earned entries (auto-accrued when a customer with an active
 *     agreement pays). Pay a partner out, or cancel a wrong accrual.
 *   • Partners — the people/companies who refer, with their default terms.
 *
 * Tag a partner to a deal from the customer's detail page → "Add referral".
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { rupee, formatDate } from "@/lib/utils";
import { useReferralPartners, useReferralLeadCounts } from "@/lib/queries/referral-partners";
import { buildTrackingUrl } from "@/lib/marketing/tracking-link";
import { toast } from "sonner";
import {
  useReferralCommissions, useCancelCommission, type CommissionWithPartner,
} from "@/lib/queries/referral-commissions";
import { PayCommissionDialog } from "@/components/features/referrals/pay-commission-dialog";
import { AddPartnerDialog } from "@/components/features/referrals/add-partner-dialog";

type View = "commissions" | "partners";

const STATUS_PILL: Record<string, string> = {
  earned:    "bg-amber-soft text-amber-ink",
  paid:      "bg-emerald/10 text-emerald",
  cancelled: "bg-paper-2 text-ink-3 line-through",
};

export default function ReferralsPage() {
  const [view, setView] = React.useState<View>("commissions");
  const { data: commissions, isLoading: cLoading, error: cErr } = useReferralCommissions();
  const { data: partners, isLoading: pLoading } = useReferralPartners();
  const cancel = useCancelCommission();
  const leadCounts = useReferralLeadCounts((partners ?? []).map((p) => p.code).filter((c): c is string => !!c));

  const [payTarget, setPayTarget] = React.useState<CommissionWithPartner | null>(null);
  /* R-472: a partner can be added here, not only from a customer's "Add referral". */
  const [addPartnerOpen, setAddPartnerOpen] = React.useState(false);

  const rows = commissions ?? [];
  const owed = rows.filter((c) => c.status === "earned").reduce((s, c) => s + c.net_payable, 0);
  const paid = rows.filter((c) => c.status === "paid").reduce((s, c) => s + c.net_payable, 0);
  const tdsHeld = rows.filter((c) => c.status !== "cancelled").reduce((s, c) => s + c.tds_amount, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Sales</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Referrals & Commission</h1>
          <p className="text-sm text-ink-3 mt-1">
            Commission for people who refer or help close deals. To tag a partner on a deal, open the{" "}
            <Link href="/customers" className="text-amber hover:underline">customer</Link> → “Add referral”.
          </p>
        </div>
        <Button variant="primary" size="sm" icon="plus" onClick={() => setAddPartnerOpen(true)}>Add partner</Button>
      </div>

      {/* KPI strip */}
      <Card className="mb-6">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Owed (to pay)</p>
            <p className="font-serif text-2xl text-amber-ink mt-1">{rupee(owed, { compact: true })}</p>
          </div>
          <div>
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Paid · all time</p>
            <p className="font-serif text-2xl text-ink mt-1">{rupee(paid, { compact: true })}</p>
          </div>
          <div>
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">TDS held (194H)</p>
            <p className="font-serif text-2xl text-ink mt-1">{rupee(tdsHeld, { compact: true })}</p>
          </div>
        </div>
      </Card>

      {/* View toggle */}
      <div className="mb-4 inline-flex rounded-lg border border-hairline bg-paper-2/40 p-1 text-sm">
        {(["commissions", "partners"] as View[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-4 py-1.5 rounded-md capitalize transition-colors ${
              view === v ? "bg-paper text-ink shadow-sm font-medium" : "text-ink-3 hover:text-ink"
            }`}
          >
            {v === "commissions" ? "Commissions" : "Referral partners"}
          </button>
        ))}
      </div>

      {/* ── Commissions ─────────────────────────────────────────── */}
      {view === "commissions" && (
        cLoading ? (
          <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
        ) : cErr ? (
          <Card><p className="text-sm text-rose">Couldn&apos;t load commissions. Please refresh.</p></Card>
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState
              icon="award"
              title="No commissions yet"
              body="Tag a referral partner on a customer's deal (customer → Add referral). When that customer pays, the commission shows up here automatically."
              action={<Button asChild variant="primary" size="sm"><Link href="/customers">Open customers</Link></Button>}
              secondary={<Button variant="ghost" size="sm" onClick={() => setAddPartnerOpen(true)}>Add partner</Button>}
            />
          </Card>
        ) : (
          <>
            {/* Mobile cards */}
            <ul className="md:hidden space-y-2">
              {rows.map((c) => (
                <li key={c.id} className="rounded-lg border border-hairline bg-paper p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink truncate">{c.partner_name ?? "—"}</span>
                    <span className="font-serif tabular-nums text-ink">{rupee(c.net_payable)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-ink-3 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded ${STATUS_PILL[c.status]}`}>{c.status}</span>
                    <span>· {formatDate(c.earned_date)}</span>
                    <span>· base {rupee(c.base_amount)}</span>
                    {c.tds_amount > 0 && <span>· TDS {rupee(c.tds_amount)}</span>}
                  </div>
                  {c.status === "earned" && (
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => setPayTarget(c)}>Pay</Button>
                      <Button size="sm" variant="ghost" onClick={() => cancel.mutate(c.id)}>Cancel</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {/* Desktop table */}
            <Card className="hidden md:block p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-paper-2 border-b border-hairline">
                    <tr className="text-left text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                      <th className="p-3">Earned</th>
                      <th className="p-3">Partner</th>
                      <th className="p-3 text-right">Base (ex-GST)</th>
                      <th className="p-3 text-right">Gross</th>
                      <th className="p-3 text-right">TDS</th>
                      <th className="p-3 text-right">Net</th>
                      <th className="p-3">Status</th>
                      <th className="p-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                        <td className="p-3 whitespace-nowrap text-ink-2">{formatDate(c.earned_date)}</td>
                        <td className="p-3 font-medium text-ink">
                          {c.partner_name ?? "—"}
                          <span className="ml-2 text-xs text-ink-3">
                            {c.basis === "percent" ? `${c.rate ?? 0}%` : "fixed"}
                          </span>
                        </td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{rupee(c.base_amount)}</td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{rupee(c.gross_commission)}</td>
                        <td className="p-3 text-right tabular-nums text-ink-3">{c.tds_amount > 0 ? rupee(c.tds_amount) : "—"}</td>
                        <td className="p-3 text-right font-serif tabular-nums text-ink">{rupee(c.net_payable)}</td>
                        <td className="p-3"><span className={`px-1.5 py-0.5 rounded text-2xs ${STATUS_PILL[c.status]}`}>{c.status}</span></td>
                        <td className="p-3 text-right">
                          {c.status === "earned" ? (
                            <div className="flex justify-end gap-1">
                              <Button size="sm" variant="primary" onClick={() => setPayTarget(c)}>Pay</Button>
                              <Button size="sm" variant="ghost" onClick={() => cancel.mutate(c.id)}>Cancel</Button>
                            </div>
                          ) : c.status === "paid" ? (
                            <span className="text-xs text-emerald inline-flex items-center gap-1"><Icon name="check" className="w-3 h-3" /> {c.paid_date ? formatDate(c.paid_date) : "Paid"}</span>
                          ) : <span className="text-xs text-ink-3">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )
      )}

      {/* ── Partners ────────────────────────────────────────────── */}
      {view === "partners" && (
        pLoading ? (
          <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
        ) : (partners ?? []).length === 0 ? (
          <Card>
            <EmptyState
              icon="users"
              title="No partners yet"
              body="Add the people who bring you customers. Then tag them on a deal from the customer page (customer → Add referral)."
              action={<Button variant="primary" size="sm" icon="plus" onClick={() => setAddPartnerOpen(true)}>Add partner</Button>}
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {(partners ?? []).map((p) => (
              <Card key={p.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-ink">{p.name}</p>
                    {p.phone && <p className="text-[12px] text-ink-3">{p.phone}</p>}
                  </div>
                  {p.deduct_tds && <span className="text-3xs px-1.5 py-0.5 rounded bg-paper-2 text-ink-3">TDS {p.tds_rate ?? 2}%</span>}
                </div>
                <div className="mt-2 text-[12px] text-ink-2">
                  Default: {p.default_basis === "percent" ? `${p.default_percent ?? 0}% of deal` : rupee(p.default_fixed_amount ?? 0)}
                </div>
                {p.pan && <p className="mt-1 text-xs font-mono text-ink-3">PAN {p.pan}</p>}
                {p.code && <PartnerLink name={p.name} phone={p.phone} code={p.code} counts={leadCounts.data?.[p.code]} />}
              </Card>
            ))}
          </div>
        )
      )}

      <AddPartnerDialog open={addPartnerOpen} onOpenChange={setAddPartnerOpen} />
      <PayCommissionDialog open={!!payTarget} onOpenChange={(o) => !o && setPayTarget(null)} commission={payTarget} />
    </div>
  );
}

/**
 * The partner's share link. Leads who fill the enquiry form from it arrive tagged with the
 * partner's code, and are counted here (and under Referral in ROAS & CAC). The commission
 * itself still starts from an agreement on the customer, once the lead becomes one.
 */
function PartnerLink({ name, phone, code, counts }: {
  name: string; phone: string | null; code: string; counts?: { leads: number; won: number };
}) {
  const origin = (process.env.NEXT_PUBLIC_APP_URL?.trim() || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/+$/, "");
  const url = origin ? buildTrackingUrl({ origin, path: "/enquiry", channel: "referral", medium: "partner", campaign: code }) : "";
  const msg = `Namaste ${name.split(" ")[0]}, ye aapka referral link hai. Jise bhi business email / Google Workspace / Microsoft 365 ya software chahiye, unhe ye link bhejiye — enquiry aapke naam se aayegi: ${url}`;
  const digits = (phone ?? "").replace(/\D/g, "");
  const wa = digits ? `https://wa.me/${digits.length === 10 ? "91" + digits : digits}?text=${encodeURIComponent(msg)}` : null;
  return (
    <div className="mt-3 border-t border-hairline pt-2 space-y-1.5">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-ink-3">Referral link · <code className="text-ink-2">{code}</code></span>
        <span className="text-ink-2">{counts?.leads ?? 0} leads · {counts?.won ?? 0} won</span>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" icon="copy" disabled={!url} onClick={async () => {
          try { await navigator.clipboard.writeText(url); toast.success("Link copy ho gaya"); } catch { toast.error("Copy nahi hua"); }
        }}>Copy link</Button>
        {wa && <a href={wa} target="_blank" rel="noopener noreferrer"><Button variant="ghost" size="sm" icon="whatsapp">WhatsApp par bhejo</Button></a>}
      </div>
    </div>
  );
}
