/**
 * Private Vault → Overview. One number the owner actually wants: net worth.
 *
 * ─── THE STALENESS BANNER IS NOT DECORATION ─────────────────────────────────
 * Every figure here was typed by hand — nothing talks to a bank or an AMC. A confident
 * ₹2.4 Cr computed from a valuation entered in March is worse than no figure, because it
 * gets used to make a decision. So the share of the total sitting behind an old or
 * never-set valuation is shown next to the total, not buried on another tab.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { usePersonalAccounts, usePersonalHoldings, usePersonalTransactions } from "@/lib/queries/personal-vault";
import { computeNetWorth, summariseCashFlow, STALE_AFTER_DAYS } from "@/lib/vault/personal/net-worth";
import { VaultPinSettings } from "@/components/features/vault/vault-pin-settings";
import { VaultLoadError } from "@/components/features/vault/vault-load-error";
import { rupee } from "@/lib/utils";
import { fyStartISO } from "@/lib/dates/ist";

export default function PersonalVaultOverview() {
  const accountsQ = usePersonalAccounts();
  const holdingsQ = usePersonalHoldings();
  const txQ = usePersonalTransactions(500);

  const loading = accountsQ.isLoading || holdingsQ.isLoading || txQ.isLoading;
  const error = accountsQ.error || holdingsQ.error || txQ.error;

  const now = React.useMemo(() => new Date(), []);
  const nw = React.useMemo(
    () => computeNetWorth(accountsQ.data ?? [], holdingsQ.data ?? [], now),
    [accountsQ.data, holdingsQ.data, now],
  );

  // This financial year so far — the window an Indian owner thinks in.
  // IST, not the browser's clock (R-1609): a laptop on another timezone near 31 Mar / 1 Apr
  // used to pick the wrong FY.
  const fyStart = React.useMemo(() => fyStartISO(now), [now]);

  const flow = React.useMemo(
    () => summariseCashFlow((txQ.data ?? []).filter((t) => t.occurred_on >= fyStart)),
    [txQ.data, fyStart],
  );

  if (error) {
    return <VaultLoadError error={error} onRetry={() => { void accountsQ.refetch(); void holdingsQ.refetch(); void txQ.refetch(); }} />;
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const empty = (accountsQ.data?.length ?? 0) === 0 && (holdingsQ.data?.length ?? 0) === 0;

  return (
    <div className="space-y-5">
      {/* ── Net worth ─────────────────────────────────────────────────────── */}
      <Card className="p-6 md:p-8">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-medium">Net worth</p>
        <div className="mt-1">
          <Money amount={nw.net} size="display" />
        </div>

        <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-4 pt-5 border-t border-hairline">
          <div>
            <p className="text-2xs uppercase tracking-wide text-ink-4">Bank, cash & deposits</p>
            <div className="mt-0.5"><Money amount={nw.liquidAssets} size="display" /></div>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wide text-ink-4">Investments</p>
            <div className="mt-0.5"><Money amount={nw.investments} size="display" /></div>
          </div>
          <div>
            <p className="text-2xs uppercase tracking-wide text-ink-4">Owed (cards)</p>
            <div className="mt-0.5">
              <Money amount={nw.liabilities} size="display" tone={nw.liabilities > 0 ? "negative" : "default"} autoNegative={false} />
            </div>
          </div>
        </div>

        {/* Said next to the number it qualifies, never on another tab. */}
        {(nw.neverValuedCount > 0 || nw.staleCount > 0) && nw.investments > 0 && (
          <div className="mt-4 flex gap-2.5 rounded-lg border border-amber/30 bg-amber-soft p-3">
            <Icon name="alert" size={15} className="text-amber-ink flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-ink leading-relaxed">
              <b>{rupee(nw.staleValue)}</b> ka figure purana hai — is total ka{" "}
              {Math.round((nw.staleValue / nw.investments) * 100)}%.{" "}
              {nw.neverValuedCount > 0 && <>{nw.neverValuedCount} holding ka value kabhi update nahi hua. </>}
              {nw.staleCount > 0 && <>{nw.staleCount} ka {STALE_AFTER_DAYS} din se zyada purana hai. </>}
              Ye aankda utna hi sahi hai jitna aakhri baar aapne likha tha.
            </p>
          </div>
        )}
      </Card>

      {empty ? (
        <Card className="p-6">
          <EmptyState
            icon="wallet"
            title="Vault abhi khali hai"
            body="Apne personal bank account, drawings aur investments yahan add karo. Ye sab sirf aapko dikhta hai — team me kisi ko nahi."
            action={<Button onClick={() => { window.location.href = "/vault/personal/banking"; }}>Banking se shuru karo</Button>}
          />
        </Card>
      ) : (
        <>
          {/* ── This FY's personal cash flow ────────────────────────────────── */}
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-ink">Is financial year me</h2>
              <span className="text-2xs text-ink-4 font-mono">{fyStart} se aaj tak</span>
            </div>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-2xs uppercase tracking-wide text-ink-4">Company se nikala</p>
                <div className="mt-0.5"><Money amount={flow.drawnFromCompany} size="display" /></div>
                <p className="text-3xs text-ink-4 mt-0.5">drawings + dividend</p>
              </div>
              <div>
                <p className="text-2xs uppercase tracking-wide text-ink-4">Kul aaya</p>
                <div className="mt-0.5"><Money amount={flow.moneyIn} size="display" /></div>
              </div>
              <div>
                <p className="text-2xs uppercase tracking-wide text-ink-4">Kharch hua</p>
                <div className="mt-0.5"><Money amount={flow.moneyOut} size="display" /></div>
              </div>
              <div>
                <p className="text-2xs uppercase tracking-wide text-ink-4">Bacha</p>
                <div className="mt-0.5"><Money amount={flow.net} size="display" /></div>
              </div>
            </div>
          </Card>

          {/* ── Allocation ──────────────────────────────────────────────────── */}
          {nw.byClass.length > 0 && (
            <Card className="p-5">
              <h2 className="text-sm font-medium text-ink">Paisa kahan laga hai</h2>
              <ul className="mt-3 space-y-2.5">
                {nw.byClass.map((c) => (
                  <li key={c.assetClass}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-ink">{c.label}</span>
                      <span className="flex items-baseline gap-2">
                        <Money amount={c.currentValue} size="cell" />
                        <span className="text-2xs text-ink-4 tabular-nums w-10 text-right">
                          {c.sharePct === null ? "—" : `${c.sharePct.toFixed(0)}%`}
                        </span>
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-paper-3 overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${Math.max(1, c.sharePct ?? 0)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-4 pt-3 border-t border-hairline flex items-baseline justify-between text-sm">
                <span className="text-ink-3">Lagaya tha</span>
                <span className="flex items-baseline gap-3">
                  <Money amount={nw.investedTotal} size="cell" />
                  <span className={nw.portfolioGain >= 0 ? "text-emerald text-xs" : "text-rose text-xs"}>
                    {nw.portfolioGain >= 0 ? "+" : ""}{rupee(nw.portfolioGain)}
                    {nw.portfolioGainPct !== null && ` (${nw.portfolioGainPct >= 0 ? "+" : ""}${nw.portfolioGainPct.toFixed(1)}%)`}
                  </span>
                </span>
              </div>
            </Card>
          )}
        </>
      )}

      <VaultPinSettings />
    </div>
  );
}
