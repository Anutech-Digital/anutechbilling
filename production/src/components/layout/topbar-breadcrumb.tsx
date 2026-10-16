"use client";

/**
 * R-1409 (Pawan, staging, 12 Oct 2026): the top-bar breadcrumb was plain text, so
 * "Sales › Marketing Hub › Spend" could not take you back to Marketing Hub, and /settings
 * ("Settings › Settings") warned about a duplicate React key because crumbs were keyed by label.
 *
 * Every crumb except the last is now a link to the page it names — when that page exists in
 * the nav (nav.ts, read only), is not the page you are on, and the role may open it
 * (canOpenRoute: a link that bounces to ROLE_HOME is worse than text). The last crumb is the
 * current page: plain text with aria-current="page".
 */
import * as React from "react";
import Link from "next/link";
import type { Route } from "next";

import { Icon } from "@/components/ui/icon";
import { APP_NAV, SCREEN_TITLES, canOpenRoute, navItemContains, sectionCrumb, type NavItem } from "@/lib/nav";

export interface CrumbLink {
  label: string;
  /** Page this crumb opens, or null when it stays text. */
  href: string | null;
}

const sameCrumb = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const isStatic = (href: string) => href.startsWith("/") && !href.includes("[");
const isUnder = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + "/");

/** The crumb head ("Sales", "Billing", …) → first page the role may open in the section
 *  named that. Two sections can share a crumb (Bill and Buy are both "Billing"): the one
 *  holding the current page goes first. Rows filed elsewhere under this head
 *  (`crumbSection`, R-821) are only the fallback. */
function headHref(label: string, pathname: string, role: string | null | undefined): string | null {
  const holds = (items: NavItem[]) => items.some((item) => navItemContains(item, pathname) || isUnder(pathname, item.href));
  const sections = APP_NAV.filter((s) => sectionCrumb(s) === label).map((s) => s.items);
  const ordered = [...sections.filter(holds), ...sections.filter((items) => !holds(items))];
  const borrowed = APP_NAV.flatMap((s) => s.items.filter((item) => item.crumbSection === label));
  for (const items of [...ordered, borrowed]) {
    const first = items.find((i) => !i.headerOnly && !i.external && isStatic(i.href) && canOpenRoute(role, i.href));
    if (first) return first.href;
  }
  return null;
}

/** A middle crumb → the static page whose own crumb is exactly the crumb up to here,
 *  preferring an ancestor of the current path. */
function middleHref(prefix: string[], pathname: string, role: string | null | undefined): string | null {
  const keys = Object.keys(SCREEN_TITLES).filter((k) => isStatic(k) && sameCrumb(SCREEN_TITLES[k], prefix));
  const pick = keys.find((k) => isUnder(pathname, k)) ?? keys[0];
  return pick && canOpenRoute(role, pick) ? pick : null;
}

export function resolveCrumbLinks(pathname: string, crumb: string[], role?: string | null): CrumbLink[] {
  return crumb.map((label, i) => {
    if (i === crumb.length - 1) return { label, href: null };
    const href = i === 0 ? headHref(label, pathname, role) : middleHref(crumb.slice(0, i + 1), pathname, role);
    return { label, href: href && href !== pathname ? href : null };
  });
}

interface TopBarBreadcrumbProps {
  pathname: string;
  crumb: string[];
  /** Current user's role; unknown (loading) → links shown, like canOpenRoute. */
  role?: string | null;
}

/** The crumbs themselves; topbar.tsx owns the surrounding <nav aria-label="Breadcrumb">. */
export function TopBarBreadcrumb({ pathname, crumb, role }: TopBarBreadcrumbProps) {
  const items = resolveCrumbLinks(pathname, crumb, role);
  return (
    <>
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          /* Keyed by position + label: /settings is "Settings › Settings" (R-1409). */
          <React.Fragment key={`${i}:${c.label}`}>
            {i > 0 && <Icon name="chevron-right" size={12} className="text-ink-4 flex-shrink-0" />}
            {last ? (
              <span aria-current="page" className="font-semibold text-ink truncate">{c.label}</span>
            ) : c.href ? (
              <Link
                href={c.href as Route}
                className="truncate rounded-sm hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-1 focus-visible:ring-offset-paper"
              >
                {c.label}
              </Link>
            ) : (
              <span className="truncate">{c.label}</span>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}
