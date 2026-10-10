/**
 * ResellerOS's design tokens as data — the one place other apps read the brand from
 * (Pawan, 10 Oct 2026: "Make our color themes dynamic … modular … better SaaS approach").
 *
 * The values are the `:root` / `.dark` custom properties of src/app/globals.css, which this app
 * itself renders with. tokens.test.ts fails when the two drift, so changing a colour means changing
 * it in both places in one commit — and every consumer (the DMS Customer Portal reads
 * GET /api/public/theme at runtime) follows without a change of its own.
 *
 * Shape is versioned and scoped so a tenant's own brand can be served later from the same endpoint
 * (`scope: "tenant"`), without consumers changing how they read it.
 */

/** HSL channel triplets, exactly as globals.css writes them: "20 91% 41%". */
export type HslTriplet = string;
/** RGB channel triplets: "194 65 12". */
export type RgbTriplet = string;

export const THEME_TOKEN_NAMES = [
  "paper", "paper-2",
  "ink", "ink-2", "ink-3", "ink-4",
  "hairline", "hairline-strong",
  "amber", "amber-soft", "amber-ink",
  "emerald", "emerald-soft", "emerald-ink",
  "rose", "rose-soft", "rose-ink",
  "indigo", "indigo-soft", "indigo-ink",
  "slate", "slate-soft",
] as const;
export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Record<ThemeTokenName, HslTriplet>;

export interface AppTheme {
  /** Bumped whenever a value changes, so a consumer can tell a cached theme is stale. */
  version: string;
  scope: "platform";
  /** The accent's tint scale (50–900) as RGB triplets, for consumers whose palettes are RGB-based. */
  accentScale: Record<"50" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900", RgbTriplet>;
  light: ThemeTokens;
  dark: ThemeTokens;
  fonts: { sans: string; serif: string; mono: string };
  radius: string;
}

export const APP_THEME: AppTheme = {
  version: "2026-10-10",
  scope: "platform",
  accentScale: {
    "50": "255 247 237", "100": "255 237 213", "200": "254 215 170", "300": "253 186 116", "400": "251 146 60",
    "500": "234 88 12", "600": "194 65 12", "700": "159 52 9", "800": "124 45 18", "900": "67 20 7",
  },
  light: {
    paper: "45 33% 97%", "paper-2": "40 22% 94%",
    ink: "24 13% 9%", "ink-2": "28 9% 32%", "ink-3": "33 7% 41%", "ink-4": "35 9% 64%",
    hairline: "38 25% 87%", "hairline-strong": "38 18% 75%",
    amber: "20 91% 41%", "amber-soft": "28 100% 95%", "amber-ink": "18 87% 33%",
    emerald: "142 71% 28%", "emerald-soft": "138 50% 92%", "emerald-ink": "142 71% 22%",
    rose: "0 76% 50%", "rose-soft": "0 86% 96%", "rose-ink": "0 74% 37%",
    indigo: "240 65% 42%", "indigo-soft": "232 100% 95%", "indigo-ink": "244 55% 32%",
    slate: "215 25% 35%", "slate-soft": "210 25% 95%",
  },
  dark: {
    paper: "24 10% 8%", "paper-2": "28 8% 12%",
    ink: "45 33% 97%", "ink-2": "33 7% 75%", "ink-3": "33 7% 55%", "ink-4": "33 6% 42%",
    hairline: "28 8% 20%", "hairline-strong": "28 8% 30%",
    amber: "20 95% 55%", "amber-soft": "22 50% 18%", "amber-ink": "28 100% 80%",
    emerald: "142 71% 50%", "emerald-soft": "142 30% 15%", "emerald-ink": "142 70% 75%",
    rose: "0 86% 65%", "rose-soft": "0 40% 18%", "rose-ink": "0 90% 80%",
    indigo: "240 65% 65%", "indigo-soft": "232 30% 18%", "indigo-ink": "232 50% 80%",
    slate: "215 25% 65%", "slate-soft": "215 20% 18%",
  },
  fonts: { sans: "Plus Jakarta Sans", serif: "DM Serif Display", mono: "JetBrains Mono" },
  radius: "8px",
};
