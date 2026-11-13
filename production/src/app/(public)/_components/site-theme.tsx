/**
 * SiteTheme — wrapper for the public marketing pages ("Warm & approachable",
 * docs/WEBSITE-THEME.md).
 *
 * Everything inside it picks up the website palette and fonts through the
 * `.site-theme` block in globals.css, which redefines the app's own tokens
 * (`--paper`, `--ink`, `--amber`…). The logged-in app never renders inside it,
 * so its look is untouched.
 *
 * Light/dark: the visitor's choice lives in localStorage `anutech-theme` and is
 * applied as `data-theme` on <html>. With no saved choice we follow the device.
 * The tiny inline script below runs while the HTML is still being parsed —
 * before the page under it paints — so a dark-mode visitor never sees a flash
 * of the light theme. It is deliberately independent of next-themes, which
 * drives the app's `.dark` class.
 */
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import { cn } from "@/lib/utils";
import { SiteBackToTop } from "./site-back-to-top";

const body = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-site-body",
  display: "swap",
});

const heading = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-site-heading",
  display: "swap",
});

/** Kept in step with THEME_STORAGE_KEY in site-theme-toggle.tsx. */
const THEME_BOOT = `(function(){var t=null;try{t=localStorage.getItem('anutech-theme')}catch(e){}if(t!=='dark'&&t!=='light'){try{t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){t='light'}}document.documentElement.setAttribute('data-theme',t)})();`;

interface SiteThemeProps {
  children: React.ReactNode;
  className?: string;
  /** Lift the back-to-top button above a floating widget in the same corner. */
  raiseBackToTop?: boolean;
}

export function SiteTheme({ children, className, raiseBackToTop = false }: SiteThemeProps) {
  return (
    <div className={cn("site-theme min-h-screen antialiased", body.variable, heading.variable, className)}>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      {children}
      <SiteBackToTop raised={raiseBackToTop} />
    </div>
  );
}
