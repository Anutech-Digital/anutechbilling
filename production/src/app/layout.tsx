import type { Metadata, Viewport } from "next";
import { SentryBoot } from "@/components/shared/sentry-boot";
import { appSans as fontSans, appSerif as fontSerif, appMono as fontMono } from "@/lib/fonts";

import "@/app/globals.css";
import { cn } from "@/lib/utils";
import { PLATFORM_OPERATOR } from "@/lib/platform";
import { Toaster } from "@/components/ui/toaster";
import { UxObserver } from "@/components/shared/ux-observer";
import { Providers } from "@/components/providers";




export const metadata: Metadata = {
  title: {
    default: "ResellerOS — Reseller business, operated.",
    template: "%s · ResellerOS",
  },
  description:
    "The complete operating system for Indian cloud resellers. Sell Google Workspace, Microsoft 365, and Zoho with built-in GST invoicing, Razorpay payments, and Premier Partner escalation.",
  keywords: [
    "Google Workspace reseller",
    "cloud reseller SaaS India",
    "GST e-invoice",
    "Razorpay billing",
    "Premier Partner",
  ],
  /* 26 Aug 2026: live deploy ke baad ye chhoot pakdi gayi. Ye `<meta name="author">` HAR
     page par jaata hai — landing, privacy, terms, sab — aur wo purani entity ka naam le
     raha tha. Mera pehla test sirf 6 public page scan karta tha; root layout usme nahi
     tha, to test green tha aur naam live par baitha tha. Test ki list ab is file ko bhi
     dekhti hai. */
  authors: [{ name: PLATFORM_OPERATOR.legalName }],
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  openGraph: {
    type: "website",
    locale: "en_IN",
    siteName: "ResellerOS",
  },
  // PWA / install-as-app
  applicationName: "ResellerOS",
  appleWebApp: {
    capable: true,
    title:   "ResellerOS",
    // iOS uses 'default', 'black', or 'black-translucent' for the status bar
    // 'default' keeps the warm cream paper feel after install.
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,  // don't auto-format Indian phone numbers as tappable nav
  },
};

export const viewport: Viewport = {
  themeColor: "#C2410C", // brand amber — used by Android Chrome toolbar tint + iOS splash
  width:      "device-width",
  initialScale: 1,
  // Pinch-zoom stays allowed (accessibility). The focus-zoom on iPhone is stopped by
  // 16px fields on phone widths — globals.css (R-267) — not by locking the scale.
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={cn(
          "min-h-screen bg-paper text-ink antialiased",
          fontSans.variable,
          fontSerif.variable,
          fontMono.variable
        )}
      >
        {/* Browser Sentry init. It fetches its own DSN from /api/monitoring/sentry-dsn
            rather than taking a prop from here — reading process.env in THIS file was the
            second of two build-time traps: the layout is a Server Component, but the pages
            under it are statically prerendered, so the read happened at build time and
            null was baked into the HTML. "On the server" is not the same as "while
            serving". Mounted in the ROOT layout so (public)/ and (auth)/ crashes report
            too; (app)/layout.tsx is "use client" and could not have read env at all. */}
        <SentryBoot />
        <Providers>{children}</Providers>
        <Toaster />
        {/* Friction signals while a person is active — lib/ux/signals.ts (3 Oct 2026). */}
        <UxObserver />
      </body>
    </html>
  );
}
