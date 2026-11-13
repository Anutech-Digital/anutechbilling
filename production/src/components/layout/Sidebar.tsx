/**
 * Sidebar — main app navigation rail.
 *
 * Desktop: sticky 240px rail
 * Mobile: slide-in sheet triggered by hamburger in TopBar
 *
 * Active state derived from Next.js usePathname().
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { Icon } from "@/components/ui/icon";
import { Avatar } from "@/components/ui/avatar";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { type UserRole, type NavItem } from "@/lib/nav";
import { buildSidebarApps, appForPath, withoutDistributorOnly, filterSidebarModelForModules, type SidebarApp } from "@/lib/nav-apps";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { TenantWithParent } from "@/lib/supabase/database.types";
import { useNavBadges } from "@/lib/hooks/useNavBadges";
import { useCurrentUser, useIdentity } from "@/lib/hooks/useCurrentUser";
import { roleLabel } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import { SYSTEM_MODULES } from "@/lib/modules/registry";
import { useModules } from "@/lib/modules/useModules";

// ============================================================
// SidebarContent — shared between desktop + mobile
// ============================================================
function SidebarContent({ onNavigate, collapsed = false, onToggle }: { onNavigate?: () => void; collapsed?: boolean; onToggle?: () => void }) {
  const pathname    = usePathname();
  const router      = useRouter();
  const navBadges   = useNavBadges();
  const { data: me } = useCurrentUser();
  const identity = useIdentity();

  // Optimistic pending navigation state for instant 0ms button click feedback
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  // Current URL search string (read safely from window after mount to avoid static prerender de-opt)
  const [currentSearch, setCurrentSearch] = React.useState<string>("");

  React.useEffect(() => {
    if (typeof window !== "undefined") {
      setCurrentSearch(window.location.search);
      const updateSearch = () => setCurrentSearch(window.location.search);
      window.addEventListener("popstate", updateSearch);
      window.addEventListener("app:tab-change", updateSearch);
      return () => {
        window.removeEventListener("popstate", updateSearch);
        window.removeEventListener("app:tab-change", updateSearch);
      };
    }
  }, [pathname]);

  // Clear pending state whenever route transition completes
  React.useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  // Eager prefetching on mouse hover or focus
  const handlePrefetch = React.useCallback((href?: string) => {
    if (href && href.startsWith("/") && !href.startsWith("//")) {
      const [path] = href.split("?");
      if (path !== pathname) {
        try {
          router.prefetch(path);
        } catch {}
      }
    }
  }, [router, pathname]);

  // Instant tactile feedback on link click / pointer-down
  const handleLinkAction = React.useCallback((href: string) => {
    const [path, query] = href.split("?");
    if (query !== undefined) {
      setCurrentSearch(`?${query}`);
    }
    if (href && href.startsWith("/") && !href.startsWith("//")) {
      setPendingHref(href);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("app:navigation-start"));
      }
      try {
        router.prefetch(path);
      } catch {}
    }
  }, [router]);

  // Which accordion parents (items with children) are expanded. Defaults to
  // open when the current route is the parent or one of its children.
  const [openMenus, setOpenMenus] = React.useState<Record<string, boolean>>({});
  /* Click the logo → see it full size (Pardeep, 3 Oct 2026). */
  const [logoOpen, setLogoOpen] = React.useState(false);

  /* R-088 — the menu is an app switcher (Sales · Billing · Accounts · Delivery · Team ·
     Settings) that shows only the chosen app's rows, with Today/Dashboard pinned above;
     see lib/nav-apps.ts. The app follows the page you are on; clicking another app peeks
     it until you navigate. A role with a short menu gets every row at once, no switcher. */
  const role = me?.role as UserRole | undefined;
  /* R-472: Partners only for a distributor tenant — same query (and cache key) as /partners. */
  const { data: hierarchy } = useQuery({
    enabled: Boolean(me?.tenantId),
    queryKey: ["tenant", "hierarchy", "partners-page"],
    queryFn: async (): Promise<TenantWithParent | null> => {
      const supabase = createClient();
      const { data } = await supabase.rpc("get_my_tenant_with_parent");
      const row = Array.isArray(data) ? data[0] : data;
      return (row as TenantWithParent | undefined) ?? null;
    },
    staleTime: 5 * 60 * 1000,
  });
  const { activeModuleIds, isLoaded: modulesLoaded, activeCount, totalCount, isFreePlanOnly } = useModules();
  const isDistributor = hierarchy === undefined ? undefined : hierarchy?.tier === "distributor";
  const model = React.useMemo(() => {
    const base = withoutDistributorOnly(buildSidebarApps(role), role, isDistributor);
    return filterSidebarModelForModules(base, modulesLoaded ? activeModuleIds : undefined);
  }, [role, isDistributor, activeModuleIds, modulesLoaded]);
  const routeApp = appForPath(model, pathname);
  const [pickedApp, setPickedApp] = React.useState<string | null>(null);
  // The last app the route pointed at — so a pinned page (/dashboard) or a page outside the
  // nav keeps the app you were in instead of jumping back to the first one.
  const [lastRouteApp, setLastRouteApp] = React.useState<string | null>(null);
  React.useEffect(() => {
    setPickedApp(null);
    if (routeApp) setLastRouteApp(routeApp);
  }, [pathname, routeApp]);
  const activeApp =
    model.apps.find((a) => a.id === (pickedApp ?? routeApp ?? lastRouteApp)) ?? model.apps[0];

  // Pre-warm items when hovering over an app button
  const handleAppHover = React.useCallback((app: SidebarApp) => {
    if (!app?.items) return;
    for (const item of app.items.slice(0, 3)) {
      if (item.href && item.href.startsWith("/")) {
        try {
          router.prefetch(item.href);
        } catch {}
      }
    }
  }, [router]);

  // Reusable link (plain item + accordion children).
  const renderLink = (it: NavItem, child = false) => {
    const [itemPath, itemQuery] = it.href.split("?");
    const isTargetActive = itemQuery
      ? (pendingHref ? pendingHref === it.href : pathname === itemPath && (currentSearch === `?${itemQuery}` || currentSearch.includes(itemQuery)))
      : (pendingHref ?? pathname) === it.href;
    const isPending = pendingHref === it.href && (pathname !== itemPath || (itemQuery ? !currentSearch.includes(itemQuery) : false));
    const b = it.badge ?? navBadges[it.id as keyof typeof navBadges];
    return (
      <Link
        key={it.id}
        href={it.href as any}
        prefetch={true}
        onMouseEnter={() => handlePrefetch(it.href)}
        onFocus={() => handlePrefetch(it.href)}
        onPointerDown={() => handleLinkAction(it.href)}
        onClick={() => {
          handleLinkAction(it.href);
          onNavigate?.();
        }}
        target={it.external ? "_blank" : undefined}
        rel={it.external ? "noopener noreferrer" : undefined}
        title={collapsed ? (it.hint ? `${it.label} — ${it.hint}` : it.label) : it.hint}
        className={cn(
          "group relative flex items-center rounded-md text-sm transition-all duration-100 select-none",
          collapsed ? "justify-center px-0 py-2" : child ? "gap-2 pl-7 pr-3 py-1.5 text-[13px]" : "gap-2.5 px-3 py-1.5",
          isTargetActive
            ? "bg-amber-soft text-amber-ink font-medium shadow-2xs"
            : "text-ink-2 hover:bg-paper-2 hover:text-ink active:scale-[0.98]"
        )}
        aria-current={isTargetActive ? "page" : undefined}
      >
        {child && !collapsed
          ? <Icon name={it.icon ?? "circle"} size={13} className={cn("flex-shrink-0 transition-colors mr-0.5", isTargetActive ? "text-amber" : "text-ink-3/80 group-hover:text-ink-2")} />
          : <Icon name={it.icon} size={15} className={cn("flex-shrink-0 transition-colors", isTargetActive ? "text-amber" : "text-ink-3 group-hover:text-ink-2")} />}
        {!collapsed && <span className="flex-1 truncate" title={it.label}>{it.label}</span>}
        {isPending && (
          <span className="w-1.5 h-1.5 rounded-full bg-amber animate-ping shrink-0 ml-1" title="Loading..." />
        )}
        {!collapsed && it.external && <Icon name="external" size={12} className="flex-shrink-0 text-ink-3" />}
        {b && (collapsed ? (
          <span className="absolute top-1 right-2 w-1.5 h-1.5 rounded-full bg-amber" />
        ) : (
          <span className={cn("text-3xs px-1.5 py-0.5 rounded-full tabular-nums flex-shrink-0", isTargetActive ? "bg-amber/15 text-amber-ink" : "bg-paper-2 text-ink-3")}>
            {b}
          </span>
        ))}
      </Link>
    );
  };

  // A group item — accordion parent (has children, e.g. Reports) or plain link.
  const renderItem = (item: NavItem) => {
    const [itemPath, itemQuery] = item.href.split("?");
    const active = itemQuery
      ? (pendingHref ? pendingHref === item.href : pathname === itemPath && (currentSearch === `?${itemQuery}` || currentSearch.includes(itemQuery)))
      : (pendingHref ?? pathname) === itemPath;
    const isPending = pendingHref === item.href && pathname !== itemPath;
    /* R-497: a heading-only row (the role may open some children, not the row itself — a
       sales user's Customers → Contacts). Expanded: a toggle button, open by default.
       Collapsed: just the children it holds, as icon rows. Never a link to the parent. */
    if (item.headerOnly && item.children?.length) {
      if (collapsed) return <React.Fragment key={item.id}>{item.children.map((c) => renderLink(c))}</React.Fragment>;
      const isOpen = openMenus[item.id] ?? true;
      return (
        <div key={item.id}>
          <button
            type="button"
            onClick={() => setOpenMenus((m) => ({ ...m, [item.id]: !isOpen }))}
            aria-expanded={isOpen}
            className="group w-full flex items-center gap-2.5 rounded-md text-sm transition-colors px-3 py-1.5 text-ink-2 hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber active:scale-[0.98]"
          >
            <Icon name={item.icon} size={15} className="flex-shrink-0 text-ink-3 group-hover:text-ink-2" />
            <span className="flex-1 truncate text-left" title={item.label}>{item.label}</span>
            <Icon name={isOpen ? "chevron_up" : "chevron_down"} size={14} className="flex-shrink-0 text-ink-3" />
          </button>
          {isOpen && (
            <div className="mt-0.5 space-y-0.5">
              {item.children.map((c) => renderLink(c, true))}
            </div>
          )}
        </div>
      );
    }
    if (item.children?.length && !collapsed) {
      const isOpen = openMenus[item.id] ?? (active || (pathname === itemPath) || item.children.some((c) => pathname === c.href.split("?")[0]));
      return (
        <div key={item.id}>
          <div className="flex items-center">
            <Link
              href={item.href as any}
              prefetch={true}
              onMouseEnter={() => handlePrefetch(item.href)}
              onFocus={() => handlePrefetch(item.href)}
              onPointerDown={() => handleLinkAction(item.href)}
              onClick={() => {
                handleLinkAction(item.href);
                onNavigate?.();
              }}
              className={cn(
                "group flex items-center gap-2.5 rounded-md text-sm transition-all duration-100 flex-1 px-3 py-1.5 select-none",
                active ? "bg-amber-soft text-amber-ink font-medium shadow-2xs" : "text-ink-2 hover:bg-paper-2 hover:text-ink active:scale-[0.98]"
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon name={item.icon} size={15} className={cn("flex-shrink-0 transition-colors", active ? "text-amber" : "text-ink-3 group-hover:text-ink-2")} />
              <span className="flex-1 truncate" title={item.label}>{item.label}</span>
              {isPending && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber animate-ping shrink-0 ml-1" title="Loading..." />
              )}
            </Link>
            <button
              type="button"
              onClick={() => setOpenMenus((m) => ({ ...m, [item.id]: !isOpen }))}
              aria-label={isOpen ? `Collapse ${item.label}` : `Expand ${item.label}`}
              aria-expanded={isOpen}
              className="p-1.5 rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              <Icon name={isOpen ? "chevron_up" : "chevron_down"} size={14} />
            </button>
          </div>
          {isOpen && (
            <div className="mt-0.5 space-y-0.5">
              {item.children!.map((c) => renderLink(c, true))}
            </div>
          )}
        </div>
      );
    }
    /* R-497: the collapsed rail has no accordion, so its children (Customers → Contacts) were
       unreachable there. Show them as icon rows under the parent while you are inside it —
       click Customers, and Parent Accounts + Contacts appear below it. */
    if (item.children?.length && collapsed && (active || pathname === itemPath || item.children.some((c) => pathname === c.href.split("?")[0]))) {
      return (
        <div key={item.id} className="space-y-0.5">
          {renderLink(item)}
          {item.children.map((c) => renderLink(c, true))}
        </div>
      );
    }
    return renderLink(item);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Brand — shows the LOGGED-IN tenant name (not hardcoded) */}
      <div className={cn("flex items-center gap-2.5 border-b border-hairline flex-shrink-0", collapsed ? "justify-center px-2 py-4" : "px-4 py-4")}>
        {/* The dark tile is for the letter monogram only. A real logo sits on the app's own
            background — on the tile, a transparent logo showed a dark square behind it
            (Pardeep, 3 Oct 2026: "logo ka background app ke background se match karo"). */}
        {/* A logo gets room to be read (Pardeep, 3 Oct: "bahut chota dikh raha hai") — 56px
            open, 40px when the sidebar is collapsed; the monogram stays 36px. */}
        <div className={cn(
          "rounded-md grid place-items-center font-serif text-lg flex-shrink-0 overflow-hidden",
          me?.tenantLogoUrl ? (collapsed ? "w-10 h-10 bg-transparent" : "w-14 h-14 bg-transparent") : "w-9 h-9 bg-ink text-paper",
        )}>
          {me?.tenantLogoUrl ? (
            <button type="button" onClick={() => setLogoOpen(true)} title="View logo" aria-label="View company logo" className="h-full w-full rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-amber">
              {/* eslint-disable-next-line @next/next/no-img-element -- next.config images.unoptimized: next/image would serve it unchanged (R-331: this disable sat one line too high) */}
              <img src={me.tenantLogoUrl} alt={me.tenantName ?? "Logo"} className="h-full w-full object-contain" />
            </button>
          ) : (
            (me?.tenantName ?? "R").charAt(0).toUpperCase()
          )}
        </div>
        {me?.tenantLogoUrl && (
          <Dialog open={logoOpen} onOpenChange={setLogoOpen}>
            <DialogContent className="max-w-md p-6 grid place-items-center">
              <DialogTitle className="sr-only">{me.tenantName ?? "Company logo"}</DialogTitle>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={me.tenantLogoUrl} alt={me.tenantName ?? "Logo"} className="max-h-[70vh] w-full max-w-[360px] object-contain" />
              {me.tenantName && <p className="mt-3 text-sm font-medium text-ink text-center">{me.tenantName}</p>}
            </DialogContent>
          </Dialog>
        )}
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight">ResellerOS</div>
            {/* The COMPANY you are inside. A generic "Workspace" here is what let a
                colleague work for two days in a private tenant without noticing —
                so when there is no company to name, say that instead of a word that
                looks like one. */}
            <div
              className={cn(
                "text-2xs truncate",
                identity.status === "member" ? "text-ink-3" : "text-amber-ink",
              )}
              title={me?.tenantName ?? "No workspace"}
            >
              {identity.status === "member"
                ? me?.tenantName
                : identity.status === "loading"
                  ? "…"
                  : "No workspace"}
            </div>
          </div>
        )}
      </div>

      {/* Nav scroll area — rows filtered by the current user's role, then shown one
          app at a time (R-088, lib/nav-apps.ts). overflow-x-hidden (R-180): overflow-y-auto alone
          makes the browser compute overflow-x as auto too, so one long label drew a left-right
          scrollbar under the menu. Labels truncate with a title tooltip instead. */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3 space-y-0.5">
        {!collapsed && (
          <div className="px-1 mb-2.5">
            <Link
              href="/settings/modules"
              prefetch={true}
              onMouseEnter={() => handlePrefetch("/settings/modules")}
              onFocus={() => handlePrefetch("/settings/modules")}
              onPointerDown={() => handleLinkAction("/settings/modules")}
              onClick={() => {
                handleLinkAction("/settings/modules");
                onNavigate?.();
              }}
              className={cn(
                "flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border border-indigo-200 bg-indigo-50/70 hover:bg-indigo-100/70 text-indigo-900 transition-all duration-100 shadow-2xs active:scale-[0.98]",
                (pendingHref ?? pathname) === "/settings/modules" && "ring-2 ring-indigo-500 bg-indigo-100",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-indigo-600 animate-pulse" />
                <span className="text-xs font-semibold tracking-tight">Plugin Marketplace</span>
              </div>
              <span className="text-3xs font-mono bg-indigo-200 text-indigo-800 px-1.5 py-0.5 rounded font-bold">
                {isFreePlanOnly ? "Free Tier" : `${activeCount}/${totalCount} Active`}
              </span>
            </Link>
          </div>
        )}
        {/* Mobile-only quick-grid — surface My Expenses & top tools at the top of the "More" drawer */}
        <div className="md:hidden">
          <div className="px-3 py-1 text-3xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">Quick Actions</div>
          <div className="grid grid-cols-2 gap-2 px-1 pb-3 mb-1 border-b border-hairline">
            {[
              { href: "/my-expenses",   label: "My Expenses", icon: "wallet" },
              { href: "/attendance/me", label: "Attendance",  icon: "calendar" },
              ...(me?.role === "owner" || me?.role === "manager" ? [
                { href: "/quotes",    label: "Quotes",    icon: "file" },
                { href: "/payments",  label: "Payments",  icon: "rupee" },
              ] : [
                { href: "/leads",     label: "Leads",     icon: "inbox" },
                { href: "/deals",     label: "Deals",     icon: "target" },
              ]),
            ].map((m) => (
              <Link
                key={m.href}
                href={m.href as never}
                prefetch={true}
                onMouseEnter={() => handlePrefetch(m.href)}
                onFocus={() => handlePrefetch(m.href)}
                onPointerDown={() => handleLinkAction(m.href)}
                onClick={() => {
                  handleLinkAction(m.href);
                  onNavigate?.();
                }}
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-hairline bg-amber-soft/40 px-3 py-2.5 text-sm font-semibold text-ink hover:bg-amber-soft active:bg-amber-soft/70 active:scale-[0.98] transition-all duration-100",
                  (pendingHref ?? pathname) === m.href && "ring-2 ring-amber bg-amber-soft",
                )}
              >
                <Icon name={m.icon} size={16} className="text-amber shrink-0" />
                <span className="truncate" title={m.label}>{m.label}</span>
              </Link>
            ))}
          </div>
        </div>
        {model.pinned.length > 0 && (
          <div className={cn("space-y-0.5", model.apps.length > 0 && "pb-2 mb-2 border-b border-hairline")}>
            {model.pinned.map((it) => renderLink(it))}
          </div>
        )}

        {model.flat ? (
          model.apps.map((app) => (
            <div key={app.id} className="pb-1">
              {!collapsed && model.apps.length > 1 && (
                <div className="px-3 pt-2 pb-1 text-3xs font-bold uppercase tracking-wider text-ink-3">{app.label}</div>
              )}
              <div className="space-y-0.5">{app.items.map((it) => renderItem(it))}</div>
            </div>
          ))
        ) : (
          <>
            <div
              aria-label="Apps"
              className={cn("grid gap-1 pb-2 mb-2 border-b border-hairline", collapsed ? "grid-cols-1" : "grid-cols-3")}
            >
              {model.apps.map((app) => {
                const on = app.id === activeApp?.id;
                return (
                  <button
                    key={app.id}
                    type="button"
                    aria-pressed={on}
                    onMouseEnter={() => handleAppHover(app)}
                    onFocus={() => handleAppHover(app)}
                    onClick={() => {
                      setPickedApp(app.id);
                      handleAppHover(app);
                    }}
                    title={collapsed ? app.label : undefined}
                    aria-label={collapsed ? app.label : undefined}
                    className={cn(
                      "flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-xs transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber active:scale-95",
                      on ? "bg-amber-soft text-amber-ink font-semibold" : "text-ink-2 hover:bg-paper-2 hover:text-ink",
                    )}
                  >
                    <Icon name={app.icon} size={16} className={cn("flex-shrink-0", on ? "text-amber" : "text-ink-3")} />
                    {!collapsed && <span className="truncate max-w-full">{app.label}</span>}
                  </button>
                );
              })}
            </div>
            {activeApp && (
              <div className="space-y-0.5">
                {activeApp.items.map((it) => renderItem(it))}
              </div>
            )}
          </>
        )}

        {/* Founder-only — cross-tenant signups. Gated by the platform-admin
            allowlist (not a tenant role); the page + API re-check server-side. */}
        {me?.isPlatformAdmin && (
          <Link
            href={"/platform" as never}
            prefetch={true}
            onMouseEnter={() => handlePrefetch("/platform")}
            onFocus={() => handlePrefetch("/platform")}
            onPointerDown={() => handleLinkAction("/platform")}
            onClick={() => {
              handleLinkAction("/platform");
              onNavigate?.();
            }}
            className={cn(
              "group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-all duration-100 mt-1 border-t border-hairline pt-3 active:scale-[0.98]",
              (pendingHref ?? pathname).startsWith("/platform")
                ? "text-amber font-medium"
                : "text-ink-2 hover:bg-paper-2 hover:text-ink",
            )}
          >
            <Icon name="rocket" size={17} className={cn("flex-shrink-0", (pendingHref ?? pathname).startsWith("/platform") ? "text-amber" : "text-ink-3 group-hover:text-ink-2")} />
            {!collapsed && <span className="flex-1 text-left">Platform · Signups</span>}
          </Link>
        )}
      </nav>

      {/* Collapse toggle — desktop only (mobile sheet is always expanded) */}
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "hidden md:flex items-center border-t border-hairline text-ink-3 hover:bg-paper-2 hover:text-ink transition-colors flex-shrink-0",
            collapsed ? "justify-center py-2.5" : "gap-2 px-3 py-2"
          )}
        >
          <Icon name={collapsed ? "chevron_right" : "chevron_left"} size={16} className="flex-shrink-0" />
          {!collapsed && <span className="text-xs">Collapse</span>}
        </button>
      )}

      {/* User footer — shows REAL logged-in user (not hardcoded) */}
      <div className={cn("border-t border-hairline flex-shrink-0", collapsed ? "p-2" : "p-3")}>
        <DropdownMenu>
          <DropdownMenuTrigger
            /* Collapsed hides both lines, so the tooltip is the only place the role can
               appear — otherwise switching to the icon rail silently loses it. */
            title={collapsed ? [me?.fullName ?? me?.authEmail ?? "Account", me?.role ? roleLabel(me.role) : null].filter(Boolean).join(" · ") : undefined}
            className={cn(
              "w-full flex items-center rounded-md hover:bg-paper-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
              collapsed ? "justify-center p-1.5" : "gap-2.5 p-2"
            )}
          >
            <Avatar
              initials={me?.initials ?? "?"}
              color={(me?.color as any) ?? "amber"}
              size="md"
              status="online"
            />
            {!collapsed && (
              <>
                {/* Identity, stated plainly: name, then EMAIL, then role.
                    The email stays second — "which account am I in?" is the question
                    this corner has to answer, and it used to require opening the
                    dropdown. The role is a third line rather than appended to the
                    email, because both are truncated and appending would hide the
                    role on exactly the long addresses where it matters.
                    "Loading…" means loading and nothing else: not-signed-in and
                    signed-in-with-no-workspace each say so, and say what to do. */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {identity.status === "member"
                      ? (me?.fullName ?? me?.authEmail ?? "You")
                      : identity.status === "stranded"
                        ? "No workspace yet"
                        : identity.status === "anonymous"
                          ? "Not signed in"
                          : identity.status === "error"
                            ? "Couldn't load your account"
                            : "Loading…"}
                  </div>
                  <div
                    className={cn(
                      "text-2xs truncate",
                      identity.status === "member" ? "text-ink-3 font-mono" : "text-amber-ink",
                    )}
                    title={identity.email ?? undefined}
                  >
                    {identity.status === "member"
                      ? me?.authEmail
                      : identity.status === "stranded"
                        ? `${identity.email} · ask an owner to add you`
                        : identity.status === "anonymous"
                          ? "Sign in to see your workspace"
                          : identity.status === "error"
                            ? "Reload the page — this is a fault, not your account"
                            : "…"}
                  </div>
                  {/* Only for a real member. A role beside "Not signed in" would be a
                      claim about somebody we have not identified. roleLabel() handles a
                      value the union does not know rather than rendering blank. */}
                  {identity.status === "member" && me?.role && (
                    <div className="text-3xs uppercase tracking-wider text-ink-3 truncate">
                      {roleLabel(me.role)}
                    </div>
                  )}
                </div>
                <Icon name="chevron_up" size={13} className="text-ink-3" />
              </>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-56">
            <DropdownMenuLabel>
              {me?.authEmail ?? "Account"}
            </DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link href="/login">
                <Icon name="user" size={14} /> Login / Switch Account
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <Icon name="settings" size={14} /> Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings/modules" className="text-indigo-600 font-medium">
                <Icon name="cloud" size={14} /> Plugin Marketplace
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Icon name="users" size={14} /> Team
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              destructive
              onClick={() => {
                // POST to the server route — it clears the auth COOKIES (the
                // browser-client signOut left them, so /login bounced back) and
                // 303-redirects to /login. No client await = can't hang.
                const form = document.createElement("form");
                form.method = "POST";
                form.action = "/auth/sign-out";
                document.body.appendChild(form);
                form.submit();
              }}
            >
              <Icon name="logout" size={14} /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ============================================================
// Sidebar — desktop fixed rail
// ============================================================
export function Sidebar() {
  const [collapsed, setCollapsed] = React.useState(false);

  // Restore persisted preference on mount (avoids hydration mismatch — starts
  // expanded, snaps to saved state after mount).
  React.useEffect(() => {
    try {
      if (localStorage.getItem("ros_sidebar_collapsed") === "1") setCollapsed(true);
    } catch {}
  }, []);

  const toggle = React.useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("ros_sidebar_collapsed", next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  return (
    <aside
      className={cn(
        "hidden md:flex flex-col border-r border-hairline bg-paper sticky top-0 h-screen transition-[width] duration-200",
        collapsed ? "w-16" : "w-60"
      )}
    >
      <SidebarContent collapsed={collapsed} onToggle={toggle} />
    </aside>
  );
}

// ============================================================
// MobileSidebar — slide-out sheet (triggered by hamburger in TopBar)
// ============================================================
export function MobileSidebar({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-72 p-0 md:hidden"
        hideClose
      >
        <SidebarContent onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
