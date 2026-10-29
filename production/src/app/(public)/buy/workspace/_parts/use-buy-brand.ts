"use client";
/**
 * R-2024 (27 Oct 2026): the website company's brand on the client. The server sends it
 * (fetch-brand.ts); when its read failed on a cold start the page asks GET /api/public/brand once
 * after it loads and fills the header, footer and tab title. Until that answer `pending` is true
 * and the header shows a neutral placeholder — never "Google Workspace" as if it were the seller,
 * never another company. Shared by the desktop page, the phone flow and the thank-you page.
 */
import * as React from "react";
import type { BuyBrand } from "./brand";

const FETCH_TIMEOUT_MS = 8_000;

const str = (v: unknown) => typeof v === "string";
const strOrNull = (v: unknown) => v === null || typeof v === "string";

/** Only a well-formed brand from the endpoint is shown. */
export function isBuyBrand(v: unknown): v is BuyBrand {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return str(b.name) && (b.name as string).trim() !== ""
    && strOrNull(b.logoUrl) && strOrNull(b.gstin) && strOrNull(b.address)
    && strOrNull(b.stateCode) && strOrNull(b.phone) && strOrNull(b.email);
}

export function useBuyBrand(initial: BuyBrand | null, titlePrefix: string): { brand: BuyBrand | null; pending: boolean } {
  const [brand, setBrand] = React.useState<BuyBrand | null>(initial);
  const [pending, setPending] = React.useState(initial === null);

  React.useEffect(() => {
    if (initial) return;
    let live = true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    (async () => {
      try {
        const res = await fetch("/api/public/brand", { signal: ctl.signal, cache: "no-store" });
        const body = res.ok ? ((await res.json()) as { brand?: unknown }) : null;
        const cand = body?.brand;
        const got = isBuyBrand(cand) ? cand : null;
        if (live && got) {
          setBrand(got);
          document.title = `${titlePrefix} · ${got.name}`;
        }
      } catch {
        /* offline / aborted — the neutral header stays */
      } finally {
        clearTimeout(timer);
        if (live) setPending(false);
      }
    })();
    return () => { live = false; clearTimeout(timer); ctl.abort(); };
  }, [initial, titlePrefix]);

  /* a brand from the server always wins; the fetched one only fills a gap */
  return initial ? { brand: initial, pending: false } : { brand, pending };
}
