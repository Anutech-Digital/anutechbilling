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
import { usePathname } from "next/navigation";

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
import { buildSidebarApps, appForPath } from "@/lib/nav-apps";
import { useNavBadges } from "@/lib/hooks/useNavBadges";
import { useCurrentUser, useIdentity } from "@/lib/hooks/useCurrentUser";
import { roleLabel } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";

// ============================================================
// SidebarContent — shared between desktop + mobile
// ============================================================
function SidebarContent({ onNavigate, collapsed = false, onToggle }: { onNavigate?: () => void; collapsed?: boolean; onToggle?: () => void }) {
  const pathname    = usePathname();
  const navBadges   = useNavBadges();
  const { data: me } = useCurrentUser();
  const identity = useIdentity();
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
  const model = React.useMemo(() => buildSidebarApps(role), [role]);
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

  // Reusable link (plain item + accordion children).
  const renderLink = (it: NavItem, child = false) => {
    const isActive = pathname === it.href;
    const b = it.badge ?? navBadges[it.id as keyof typeof navBadges];
    return (
      <Link
        key={it.id}
        href={it.href as any}
        onClick={onNavigate}
        target={it.external ? "_blank" : undefined}
        rel={it.external ? "noopener noreferrer" : undefined}
        title={collapsed ? (it.hint ? `${it.label} — ${it.hint}` : it.label) : it.hint}
        className={cn(
          "group relative flex items-center rounded-md text-sm transition-colors",
          collapsed ? "justify-center px-0 py-2" : child ? "gap-2 pl-8 pr-3 py-1.5 text-[13px]" : "gap-2.5 px-3 py-1.5",
          isActive
            ? "bg-amber-soft text-amber-ink font-medium"
            : "text-ink-2 hover:bg-paper-2 hover:text-ink"
        )}
        aria-current={isActive ? "page" : undefined}
      >
        {child
          ? <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", isActive ? "bg-amber" : "bg-ink-3/40")} />
          : <Icon name={it.icon} size={15} className={cn("flex-shrink-0", isActive ? "text-amber" : "text-ink-3 group-hover:text-ink-2")} />}
        {!collapsed && <span className="flex-1 truncate" title={it.label}>{it.label}</span>}
        {!collapsed && it.external && <Icon name="external" size={12} className="flex-shrink-0 text-ink-3" />}
        {/* The expanded badge reads text-amber-ink, matching every other `bg-amber/15` badge
            in the app (dashboard:865, mobile:404, platform:398). This one was the exception:
            it measured 4.30:1 against the active row's amber-soft, under the 4.5 AA floor at
            10px — and actually worse than that, because the badge's own 15% amber tint darkens
            the very surface the measurement stopped at. */}
        {b && (collapsed ? (
          <span className="absolute top-1 right-2 w-1.5 h-1.5 rounded-full bg-amber" />
        ) : (
          <span className={cn("text-3xs px-1.5 py-0.5 rounded-full tabular-nums flex-shrink-0", isActive ? "bg-amber/15 text-amber-ink" : "bg-paper-2 text-ink-3")}>
            {b}
          </span>
        ))}
      </Link>
    );
  };

  // A group item — accordion parent (has children, e.g. Reports) or plain link.
  const renderItem = (item: NavItem) => {
    const active = pathname === item.href;
    if (item.children?.length && !collapsed) {
      const isOpen = openMenus[item.id] ?? (active || item.children.some((c) => pathname === c.href));
      return (
        <div key={item.id}>
          <div className="flex items-center">
            <Link
              href={item.href as any}
              onClick={onNavigate}
              className={cn(
                "group flex items-center gap-2.5 rounded-md text-sm transition-colors flex-1 px-3 py-1.5",
                active ? "bg-amber-soft text-amber-ink font-medium" : "text-ink-2 hover:bg-paper-2 hover:text-ink"
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon name={item.icon} size={15} className={cn("flex-shrink-0", active ? "text-amber" : "text-ink-3 group-hover:text-ink-2")} />
              <span className="flex-1 truncate" title={item.label}>{item.label}</span>
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
            /* eslint-disable-next-line @next/next/no-img-element */
            <button type="button" onClick={() => setLogoOpen(true)} title="View logo" aria-label="View company logo" className="h-full w-full rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-amber">
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
                onClick={onNavigate}
                className="flex items-center gap-2 rounded-lg border border-hairline bg-amber-soft/40 px-3 py-2.5 text-sm font-semibold text-ink hover:bg-amber-soft active:bg-amber-soft/70"
              >
                <Icon name={m.icon} size={16} className="text-amber shrink-0" />
                {/* Same reason as the two below: a label clipped to an ellipsis has hidden part
                    of itself, and `title` is the cheapest way to make it readable again. These
                    four are short enough not to clip today, and the shortcut list is edited
                    often enough that "today" is not the guarantee it sounds like. */}
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
                    onClick={() => setPickedApp(app.id)}
                    title={collapsed ? app.label : undefined}
                    aria-label={collapsed ? app.label : undefined}
                    className={cn(
                      "flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
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
            className={cn(
              "group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors mt-1 border-t border-hairline pt-3",
              pathname.startsWith("/platform")
                ? "text-amber font-medium"
                : "text-ink-2 hover:bg-paper-2 hover:text-ink",
            )}
          >
            <Icon name="rocket" size={17} className={cn("flex-shrink-0", pathname.startsWith("/platform") ? "text-amber" : "text-ink-3 group-hover:text-ink-2")} />
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
