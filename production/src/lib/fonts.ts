/**
 * Every web font the app uses, served from the repo (npm @fontsource packages) — R-182, 6 Oct 2026.
 *
 * These were `next/font/google`, which downloads from fonts.googleapis.com during `next build`.
 * On 6 Oct staging build 7031f453 died in that download ("An error occurred in `next/font`",
 * TypeError reading '1' in the Google loader) with no change of ours involved, and every build
 * paid the round trip. Same font files (Fontsource ships Google's), latin subset, so the pages
 * look the same; the build no longer needs the network for fonts.
 *
 * next/font/local wants each instance at module scope, and the CSS variable name is per
 * instance — hence one export per (font, variable) pair the pages already used.
 */
import localFont from "next/font/local";

// Paths are relative to this file and must be literals: next/font reads them at compile time.

// ── App shell (src/app/layout.tsx) ───────────────────────────────────────────
export const appSans = localFont({
  src: [{ path: "../../node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2", weight: "200 800", style: "normal" }],
  variable: "--font-sans",
  display: "swap",
});
export const appSerif = localFont({
  src: [{ path: "../../node_modules/@fontsource/dm-serif-display/files/dm-serif-display-latin-400-normal.woff2", weight: "400", style: "normal" }],
  variable: "--font-serif",
  display: "swap",
});
export const appMono = localFont({
  src: [{ path: "../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2", weight: "100 800", style: "normal" }],
  variable: "--font-mono",
  display: "swap",
});

// ── Marketing + landing pages ((marketing), (lp)) ───────────────────────────
export const archivoSans = localFont({
  src: [{ path: "../../node_modules/@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-sans",
  display: "swap",
});
export const plexMono = localFont({
  src: [
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
});

// ── Domains / hosting site (src/site) ───────────────────────────────────────

export const domainSans = localFont({ src: [{ path: "../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2", weight: "200 800", style: "normal" }], variable: "--df-sans", display: "swap" });
export const domainSerif = localFont({ src: [{ path: "../../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2", weight: "400", style: "normal" }, { path: "../../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2", weight: "400", style: "italic" }], variable: "--df-serif", display: "swap" });
export const domainMono = localFont({ src: [{ path: "../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2", weight: "100 800", style: "normal" }], variable: "--df-mono", display: "swap" });

export const hostingSans = localFont({ src: [{ path: "../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2", weight: "200 800", style: "normal" }], variable: "--hf-sans", display: "swap" });
export const hostingSerif = localFont({ src: [{ path: "../../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2", weight: "400", style: "italic" }], variable: "--hf-serif", display: "swap" });
export const hostingMono = localFont({ src: [{ path: "../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2", weight: "100 800", style: "normal" }], variable: "--hf-mono", display: "swap" });

export const trialSans = localFont({ src: [{ path: "../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2", weight: "200 800", style: "normal" }], variable: "--htf-sans", display: "swap" });
