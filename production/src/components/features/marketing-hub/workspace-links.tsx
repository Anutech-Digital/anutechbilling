"use client";

import Link from "next/link";
import type { Route } from "next";

import { Card } from "@/components/ui/card";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { isRouteAllowed, type UserRole } from "@/lib/nav";
import { MARKETING_TOOLS } from "@/lib/marketing/tool-catalog";
import { TOOL_WORKSPACES, isExternalWorkspace, workspaceRoute, type HubLink } from "@/lib/marketing/hub-navigation";

export function MarketingPageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header>
      <Link href="/marketing" className="text-xs font-medium text-amber-ink hover:underline">← Marketing Hub</Link>
      <h1 className="mt-2 font-serif text-3xl md:text-4xl">{title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-ink-3">{description}</p>
    </header>
  );
}

export function MarketingToolCard({ toolKey }: { toolKey: string }) {
  const tool = MARKETING_TOOLS.find((item) => item.key === toolKey);
  if (!tool) return null;
  const work = TOOL_WORKSPACES[toolKey];
  if (!work) return null;
  return <MarketingWorkspaceCard title={tool.name} description={tool.why} href={work.href} action={work.label} />;
}

export function MarketingWorkspaceCard({ title, description, href, action }: { title: string; description: string; href: string; action: string }) {
  const { data: me } = useCurrentUser();
  const role = me?.role as UserRole | undefined;
  const external = isExternalWorkspace(href);
  const allowed = external || Boolean(role && isRouteAllowed(role, workspaceRoute(href)));
  const card = (
    <Card className={`h-full p-5 ${allowed ? "transition hover:border-amber/60 hover:shadow-sm" : ""}`}>
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">{description}</p>
      <p className={`mt-5 text-sm font-medium ${allowed ? "text-amber-ink" : "text-ink-3"}`}>
        {allowed ? `${action} ${external ? "↗" : "→"}` : role ? "Access needed for this workspace" : "Checking access…"}
      </p>
    </Card>
  );
  if (!allowed) return <div>{card}</div>;
  if (external) return <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">{card}</a>;
  return <Link href={href as Route} className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">{card}</Link>;
}

export function MarketingActionLinks({ title, links }: { title: string; links: readonly HubLink[] }) {
  const { data: me } = useCurrentUser();
  const role = me?.role as UserRole | undefined;
  const visible = links.filter((link) => isExternalWorkspace(link.href) || Boolean(role && isRouteAllowed(role, workspaceRoute(link.href))));
  if (!visible.length) return null;
  return (
    <nav aria-label={title}>
      <h2 className="mb-3 text-base font-semibold text-ink">{title}</h2>
      <div className="flex flex-wrap gap-2">
        {visible.map((link) => <Link key={link.href} href={link.href as Route} className="rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink-2 hover:border-amber/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">{link.label} →</Link>)}
      </div>
    </nav>
  );
}
