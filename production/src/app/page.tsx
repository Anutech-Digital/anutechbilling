import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
import { SiteTheme } from "./(public)/_components/site-theme";
import { SiteHeader } from "./(public)/_components/site-header";
import { SiteFooter } from "./(public)/_components/site-footer";

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
    // raiseBackToTop: the WhatsApp button below already sits bottom-right.
    <SiteTheme raiseBackToTop>
      <SiteHeader />
      <main className="relative">
        <Hero />
        <TrustRibbon />
        <PainSection />
        <ModuleShowcase />
        <WhyUs />
        <FounderSection />
        <BetaPricing />
        <FinalCta />
      </main>
      <SiteFooter />

      {/* Floating WhatsApp Chat Widget for Instant B2B Trust */}
      <a
        href="https://wa.me/919876543210?text=Hi%20ResellerOS%20team,%20I'd%20like%20to%20know%20more%20about%20ResellerOS"
        target="_blank"
        rel="noopener noreferrer"
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-full bg-[#25D366] px-4 py-3 text-white shadow-xl hover:bg-[#20bd5a] hover:scale-105 transition-all focus:outline-none"
        title="Chat on WhatsApp with Founder / Support"
      >
        <Icon name="message_square" className="h-5 w-5 fill-current" />
        <span className="text-xs font-semibold tracking-wide sm:inline">Chat on WhatsApp</span>
      </a>
    </SiteTheme>
  );
}
