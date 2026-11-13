/**
 * Shared shell for public pages (privacy, terms, about).
 *
 * Lives under `(public)/_components/` — the `_` prefix tells Next.js this
 * isn't a route, so it doesn't try to render it as a page. Centralising
 * these here keeps the public legal/about pages consistent + avoids
 * cross-page imports that confuse the dev compiler.
 */

import { SiteTheme } from "./site-theme";
import { SiteHeader } from "./site-header";
import { SiteFooter } from "./site-footer";

export function PublicShell({
  title, subtitle, children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <SiteTheme>
      <PublicTopBar />
      <main className="max-w-3xl mx-auto px-5 py-12 md:py-16">
        <h1 className="font-serif text-4xl md:text-5xl leading-tight mb-2">{title}</h1>
        {subtitle && <p className="text-sm text-ink-3 mb-8">{subtitle}</p>}
        <div className="prose-resellersos space-y-6 text-[15px] leading-relaxed text-ink-2">
          {children}
        </div>
      </main>
      <PublicFooter />
    </SiteTheme>
  );
}

/** The public website header (site-header.tsx). Kept under this name so the
 *  pages that import it did not have to change. */
export function PublicTopBar() {
  return <SiteHeader />;
}

/** The public website footer (site-footer.tsx). The `mt-16` keeps the gap the
 *  old footer had above it. */
export function PublicFooter() {
  return (
    <div className="mt-16">
      <SiteFooter />
    </div>
  );
}

export function Intro({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-base text-ink-2 leading-relaxed border-l-2 border-amber pl-4 italic">
      {children}
    </p>
  );
}

export function TOC({ items }: { items: Array<{ id: string; label: string }> }) {
  return (
    <nav className="rounded-md border border-hairline bg-paper-2/40 px-5 py-4">
      <p className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-2">
        On this page
      </p>
      <ol className="space-y-1 text-sm text-ink-2 list-decimal pl-4 marker:text-ink-3">
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`} className="hover:text-amber transition-colors">
              {i.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Section({
  id, n, title, children,
}: {
  id: string; n: number; title: string; children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="font-serif text-2xl text-ink mb-3 leading-tight">
        <span className="text-ink-3 font-sans text-base mr-2">{n}.</span>
        {title}
      </h2>
      <div className="space-y-2 text-ink-2">{children}</div>
    </section>
  );
}

export function Callout({
  tone = "info", children,
}: {
  tone?: "info" | "warning";
  children: React.ReactNode;
}) {
  const bg = tone === "warning" ? "bg-amber-soft/40 border-amber/30" : "bg-indigo-50 border-indigo/20";
  return (
    <div className={`mt-3 rounded-md border px-4 py-3 text-[13px] text-ink-2 ${bg}`}>
      {children}
    </div>
  );
}

export function FooterMeta() {
  return (
    <p className="text-[12px] text-ink-3 italic border-t border-hairline pt-6 mt-8">
      This document is provided for transparency and compliance with the DPDP
      Act 2023. It is not a substitute for legal advice. ANUTECH DIGITAL PVT
      LTD reserves the right to update this policy as our practices or
      applicable law evolves.
    </p>
  );
}
