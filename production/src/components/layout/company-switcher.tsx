"use client";

/**
 * R-2476 (R-2471 slice 2): pick which company this login works in.
 *
 * Shown only for a login with 2+ ACTIVE memberships (my_companies()). From sm up it is its own
 * top-bar button (building icon + current company); on a phone it is a row in the More menu
 * (the 375px row has no room — topbar-phone-width.test.ts). Both open the same dialog: one row per
 * company with its name and the role there, the current one ticked. Picking another runs
 * switch_company, then finishCompanySwitch drops every cached query and the old company's
 * workspace tabs and loads the app fresh, so nothing of the old company stays on screen.
 * Logic + refusal copy: lib/auth/company-switch.ts.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { toast } from "sonner";

import { Icon } from "@/components/ui/icon";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { hasDirtyForm } from "@/lib/hooks/dirty-forms";
import { cn } from "@/lib/utils";
import {
  COMPANY_SWITCH_CHANNEL, describeSwitchRefusal, fetchMyCompanies, finishCompanySwitch, shouldShowSwitcher,
  switchCompany, SwitchRefusedError, type CompanyOption, type CompanySwitchClient,
} from "@/lib/auth/company-switch";

/** The full page load after a switch — an object so tests can replace it (jsdom has no navigation). */
export const companySwitchNav = {
  go(href: string) {
    window.location.assign(href);
  },
};

const client = () => createClient() as unknown as CompanySwitchClient;

/** The login's companies. Keyed by user, so another login in the same browser never sees this list. */
export function useMyCompanies() {
  const { data: me } = useCurrentUser();
  return useQuery({
    queryKey: ["my-companies", me?.userId ?? null],
    queryFn: () => fetchMyCompanies(client()),
    enabled: !!me?.userId && me?.role !== "personal",
    staleTime: 60_000,
    retry: false,
  });
}

/** Phone: a row in the top bar's More menu. Renders nothing for a one-company login. */
export function CompanySwitcherMenuItem({ onSelect }: { onSelect: () => void }) {
  const { data } = useMyCompanies();
  if (!shouldShowSwitcher(data)) return null;
  const current = data!.find((c) => c.isCurrent);
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Icon name="building" size={14} />
      <span className="min-w-0 truncate">Switch company{current ? ` (${current.name})` : ""}</span>
    </DropdownMenuItem>
  );
}

interface CompanySwitcherProps {
  /** Controlled open state (the phone More menu opens it); uncontrolled when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** sm+: the top-bar button. Always: the dialog. Renders nothing for a one-company login. */
export function CompanySwitcher({ open: openProp, onOpenChange }: CompanySwitcherProps) {
  const { data } = useMyCompanies();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [openState, setOpenState] = React.useState(false);
  const open = openProp ?? openState;
  const setOpen = React.useCallback((v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  }, [onOpenChange]);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const reloadFresh = React.useCallback(() => finishCompanySwitch({
    queryClient,
    storage: typeof window !== "undefined" ? window.sessionStorage : null,
    go: (href) => companySwitchNav.go(href),
  }), [queryClient]);

  /* Another browser tab of this login switched: users.tenant_id is per LOGIN (spec §2.2), so this
     tab's screen and cache are the old company's now — anything saved here would land in the new
     one. Load fresh too. */
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(COMPANY_SWITCH_CHANNEL);
    ch.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === "switched") void reloadFresh();
    };
    return () => ch.close();
  }, [reloadFresh]);

  if (!shouldShowSwitcher(data)) return null;
  const companies = data!;
  const current = companies.find((c) => c.isCurrent);

  /** Tell this login's other browser tabs to load fresh (the sender gets no copy). */
  function announce() {
    if (typeof BroadcastChannel === "undefined") return;
    try {
      const ch = new BroadcastChannel(COMPANY_SWITCH_CHANNEL);
      ch.postMessage({ type: "switched" });
      ch.close();
    } catch {
      // no channel: the other tabs follow on their next full load
    }
  }

  async function pick(c: CompanyOption) {
    if (busyId) return;
    if (c.isCurrent) {
      setOpen(false);
      return;
    }
    /* Refused up front: a switch commits on the server first, and the browser's own "Leave site?"
       for an unsaved form would then let the person stay on the OLD company's form while the
       database already points at the new one (a Save would land there). */
    if (hasDirtyForm()) {
      toast.error("Could not switch company — this page has unsaved changes.", {
        description: `Save or discard your changes first, then switch to ${c.name}.`,
      });
      return;
    }
    setBusyId(c.tenantId);
    try {
      await switchCompany(c.tenantId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[company-switch]", err);
      if (!(err instanceof SwitchRefusedError)) {
        /* The answer was lost: did the switch happen? Ask the database. Switched — or cannot
           tell — load fresh, so the screen always shows the company the database has. */
        const now = await fetchMyCompanies(client()).catch(() => null);
        const stillOld = !!now && now.find((x) => x.isCurrent)?.tenantId === current?.tenantId;
        if (!stillOld) {
          announce();
          await reloadFresh();
          return;
        }
      }
      setBusyId(null);
      const r = describeSwitchRefusal(err);
      toast.error(r.message, {
        description: r.description,
        // R-431: an error with a fix button stays long enough to press it
        ...(r.action ? { action: { label: r.action.label, onClick: () => router.push(r.action!.href as Route) }, duration: 10_000 } : {}),
      });
      return;
    }
    announce();
    await reloadFresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden sm:inline-flex items-center gap-1.5 h-8 max-w-[220px] px-2.5 rounded-md border border-hairline bg-paper-2 hover:bg-paper-3 text-xs font-medium text-ink-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={`Switch company — now in ${current?.name ?? "this company"}`}
        aria-haspopup="dialog"
        data-topbar="company"
      >
        <Icon name="building" size={14} className="shrink-0" />
        <span className="min-w-0 truncate">{current?.name ?? "Company"}</span>
        <Icon name="chevron_down" size={12} className="shrink-0 text-ink-3" />
      </button>

      <Dialog open={open} onOpenChange={(v) => { if (!busyId) setOpen(v); }}>
        <DialogContent className="md:!max-w-md">
          <DialogHeader>
            <DialogTitle>Switch company</DialogTitle>
            <DialogDescription>
              You work in one company at a time. Pick the company to open — the app reloads with only its data.
            </DialogDescription>
          </DialogHeader>
          <ul className="mt-2 space-y-1.5" aria-label="Your companies">
            {companies.map((c) => {
              const busy = busyId === c.tenantId;
              return (
                <li key={c.tenantId}>
                  <button
                    type="button"
                    onClick={() => void pick(c)}
                    disabled={!!busyId}
                    aria-current={c.isCurrent ? "true" : undefined}
                    aria-label={`${c.name}, ${c.roleLabel}${c.isCurrent ? ", current company" : ""}`}
                    className={cn(
                      "w-full flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60",
                      c.isCurrent ? "border-primary bg-primary/5" : "border-hairline hover:bg-paper-2",
                    )}
                  >
                    <Icon name="building" size={16} className="shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{c.name}</span>
                      <span className="block text-xs text-ink-3">{c.roleLabel}</span>
                    </span>
                    {busy ? (
                      <span className="shrink-0 text-xs text-ink-3" role="status">Switching…</span>
                    ) : c.isCurrent ? (
                      <span className="shrink-0 inline-flex items-center gap-1 text-xs font-medium text-primary">
                        <Icon name="check" size={14} /> Current
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
