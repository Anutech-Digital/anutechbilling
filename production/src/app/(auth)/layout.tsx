/**
 * (auth) layout — centered, chromeless layout for login + signup.
 *
 * R-1458: the brand (logo, name, tab title, footer) comes from the host — Anutech Digital
 * with a "Back to anutech.in" link on anutech.in, ResellerOS everywhere else (unchanged).
 */
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { brandForHost, hostFromHeaders } from "@/site/lib/host-brand";

async function currentBrand() {
  return brandForHost(hostFromHeaders(await headers()));
}

export async function generateMetadata(): Promise<Metadata> {
  const brand = await currentBrand();
  if (brand.site === "product") return {};
  return { title: { default: brand.titleDefault, template: brand.titleTemplate } };
}

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const brand = await currentBrand();
  return (
    <div className="min-h-screen bg-paper-2/50 flex flex-col">
      {/* Top bar with brand */}
      <header className="flex items-center justify-between gap-4 p-6">
        <Link href="/" className="flex items-center gap-2.5">
          {brand.logoSrc ? (
            <Image src={brand.logoSrc} alt={brand.name} width={120} height={40} priority style={{ objectFit: "contain", height: 40, width: "auto" }} />
          ) : (
            <>
              <div className="w-9 h-9 rounded-md bg-ink text-paper grid place-items-center font-serif text-lg">R</div>
              <div className="text-sm font-semibold">{brand.name}</div>
            </>
          )}
        </Link>
        {brand.back && (
          <Link href={brand.back.href} className="text-sm text-ink-2 hover:text-ink hover:underline">
            ← {brand.back.label}
          </Link>
        )}
      </header>
      <main className="flex-1 flex items-center justify-center px-4 pb-12">
        <div className="w-full max-w-md">{children}</div>
      </main>
      <footer className="p-6 text-center text-xs text-ink-3">
        © {new Date().getFullYear()} {brand.footer}
      </footer>
    </div>
  );
}
