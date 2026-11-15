/**
 * R-2837 — which tab / segment the customer profile shows.
 *
 * On the standalone page it lives in the URL (`?tab=transactions&show=payments`) so a link
 * (the renewals drawer's "all payments") lands on the right place and Back leaves the page.
 * In the /customers side panel there is no URL of its own, so it stays local state.
 */
"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { TxnFilter } from "./customer-transactions-tab";

export type MainTab = "overview" | "transactions" | "statement";

const TABS: readonly MainTab[] = ["overview", "transactions", "statement"];
const FILTERS: readonly TxnFilter[] = ["all", "invoices", "quotes", "payments", "projects"];

export function parseMainTab(v: string | null): MainTab {
  return TABS.includes(v as MainTab) ? (v as MainTab) : "overview";
}
export function parseTxnFilter(v: string | null): TxnFilter {
  return FILTERS.includes(v as TxnFilter) ? (v as TxnFilter) : "all";
}

export function useProfileTabState(inPanel: boolean) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [localTab, setLocalTab] = React.useState<MainTab>("overview");
  const [localFilter, setLocalFilter] = React.useState<TxnFilter>("all");

  const urlTab = parseMainTab(searchParams.get("tab"));
  const urlFilter = urlTab === "transactions" ? parseTxnFilter(searchParams.get("show")) : "all";

  const write = React.useCallback((tab: MainTab, filter: TxnFilter) => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("tab");
    next.delete("show");
    if (tab !== "overview") next.set("tab", tab);
    if (tab === "transactions" && filter !== "all") next.set("show", filter);
    const qs = next.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as never, { scroll: false });
  }, [router, pathname, searchParams]);

  const setUrlTab = React.useCallback((t: MainTab) => write(t, "all"), [write]);
  const setUrlFilter = React.useCallback((f: TxnFilter) => write("transactions", f), [write]);

  return inPanel
    ? { mainTab: localTab, setMainTab: setLocalTab, txnFilter: localFilter, setTxnFilter: setLocalFilter }
    : { mainTab: urlTab, setMainTab: setUrlTab, txnFilter: urlFilter, setTxnFilter: setUrlFilter };
}
