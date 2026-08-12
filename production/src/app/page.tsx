import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Hero,
  TrustRibbon,
  PainSection,
  ModuleShowcase,
  WhyUs,
  FounderSection,
  BetaPricing,
  FinalCta,
} from "./(public)/_components/landing-sections";

/**
 * Public marketing landing page — visual v3 (World-Class).
 *
 * Built for cold prospects (Indian cloud resellers).
 * Introduces dynamic animations (Framer Motion), glassmorphism,
 * and interactive hover states for a premium, high-trust feel.
 *
 * If a visitor is already authenticated, kick them to /dashboard
 * (unless ?preview=1 is set — useful for demos).
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: { preview?: string };
}) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user && searchParams.preview !== "1") redirect("/dashboard");

  return (
    <main className="min-h-screen bg-paper text-ink antialiased relative">
      <TopNav />
      <Hero />
      <TrustRibbon />
      <PainSection />
      <ModuleShowcase />
      <WhyUs />
      <FounderSection />
      <BetaPricing />
      <FinalCta />
      <Footer />
    </main>
  );
}

/* ───────────────────────────────────────────────────────────────
   Top nav
   ─────────────────────────────────────────────────────────────── */

function TopNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-hairline/80 bg-paper/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2 group">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-ink text-paper shadow-sm transition-transform group-hover:scale-105">
            <Icon name="layout" className="h-4 w-4" />
          </span>
          <span className="font-serif text-xl tracking-tight">ResellerOS</span>
        </Link>
        <nav className="flex items-center gap-5 text-sm font-medium text-ink-2">
          <Link href={"/pricing" as never} className="hidden sm:inline hover:text-ink transition-colors">
            Pricing
          </Link>
          <Link href={"/about" as never} className="hidden sm:inline hover:text-ink transition-colors">
            About
          </Link>
          <Link href="/login" className="hover:text-ink transition-colors">
            Sign in
          </Link>
          <Button asChild size="sm" className="shadow-sm hover:shadow-md transition-shadow">
            <Link href="/signup">Start free</Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}

/* ───────────────────────────────────────────────────────────────
   Footer
   ─────────────────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer className="border-t border-hairline bg-paper-2/40">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded bg-ink text-paper">
              <Icon name="layout" className="h-3.5 w-3.5" />
            </span>
            <span className="font-serif text-base tracking-tight">ResellerOS</span>
          </div>
          <nav className="flex flex-wrap gap-5 text-sm font-medium text-ink-2">
            <Link href={"/pricing" as never} className="hover:text-ink transition-colors">Pricing</Link>
            <Link href={"/about" as never}   className="hover:text-ink transition-colors">About</Link>
            <Link href={"/privacy" as never} className="hover:text-ink transition-colors">Privacy</Link>
            <Link href={"/terms" as never}   className="hover:text-ink transition-colors">Terms</Link>
            <a href="mailto:hello@resellersos.in" className="hover:text-amber-ink transition-colors">
              Contact
            </a>
          </nav>
        </div>
        <div className="mt-8 border-t border-hairline/60 pt-6 font-mono text-[11px] uppercase tracking-wider text-ink-3">
          Excel Technologies Pvt Ltd · Mumbai, India · Made with care for Indian resellers
        </div>
      </div>
    </footer>
  );
}
