import type { Metadata } from "next";
import { archivoSans as archivo } from "@/lib/fonts";

/**
 * Ad landing pages (R-139, 4 Oct 2026). Deliberately NOT the marketing layout: an ad visitor
 * gets one page with one job and its own small header, not the whole site menu, cart and chat
 * to wander off into. Pages here are noindex and Anutech-branded.
 */

export const metadata: Metadata = {
  title: { template: "%s · Anutech Digital", default: "Anutech Digital" },
  robots: { index: false, follow: false },
};

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return <div className={archivo.variable}>{children}</div>;
}
