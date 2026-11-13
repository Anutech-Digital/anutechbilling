/**
 * Public website theme — which look the storefront (src/site, the `(marketing)` pages) wears.
 *
 *   classic  the website as it has always been: Anutech blue, Archivo + IBM Plex Mono (site.css)
 *   warm     "Warm & approachable": teal, marigold calls to action, Inter + Plus Jakarta Sans
 *            (docs/WEBSITE-THEME.md, site-warm.css)
 *
 * Stored on the website tenant's row (tenants.website_theme, migration 20261113102122) and
 * switched by that workspace's OWNER in Settings → Branding (Pawan, 13 Nov 2026: "main admin
 * should be able to switch back and forth"). Theme only — no page text changes with it.
 *
 * Isomorphic: no server or browser APIs, so the route, the reader and the card share it.
 */

export const WEBSITE_THEMES = ["classic", "warm"] as const;
export type WebsiteTheme = (typeof WEBSITE_THEMES)[number];

/** What the website wears until the owner chooses — the migration's column default. */
export const DEFAULT_WEBSITE_THEME: WebsiteTheme = "classic";

export const WEBSITE_THEME_LABELS: Record<WebsiteTheme, { name: string; description: string }> = {
  classic: {
    name: "Classic",
    description: "The current website look: Anutech blue, Archivo headings.",
  },
  warm: {
    name: "Warm & approachable",
    description: "Teal and marigold, rounder cards and buttons, Inter and Plus Jakarta Sans.",
  },
};

/** A stored or posted value → a theme, or null when it is not one we know. Never guesses. */
export function parseWebsiteTheme(value: unknown): WebsiteTheme | null {
  return typeof value === "string" && (WEBSITE_THEMES as readonly string[]).includes(value)
    ? (value as WebsiteTheme)
    : null;
}

/** The column does not exist yet — the migration has not been applied to this database. */
export function isWebsiteThemeColumnMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  const msg = err.message ?? "";
  return /website_theme/.test(msg) && /(does not exist|could not find)/i.test(msg);
}

/** §24 copy for the not-yet-migrated database: what, why, what next. */
export const WEBSITE_THEME_NEEDS_DB =
  "The website theme switch is not available on this server yet: its database update " +
  "(migration 20261113102122_website_theme_switch) has not been applied. It goes out with the " +
  "next database deploy — until then the website stays on the Classic theme.";

export type WebsiteThemeAccess =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; error: string };

/**
 * Who may switch the website theme: the OWNER of the website's own workspace, nobody else.
 * Another reseller's workspace has no website here, so the switch would do nothing for it —
 * it is refused rather than accepted and silently ignored.
 */
export function websiteThemeAccess(input: {
  signedIn: boolean;
  role: string | null;
  tenantId: string | null;
  websiteTenantId: string | null;
}): WebsiteThemeAccess {
  if (!input.signedIn) {
    return { ok: false, status: 401, error: "You are signed out. Sign in again, then reopen Settings → Branding." };
  }
  if (!input.websiteTenantId) {
    return {
      ok: false,
      status: 503,
      error:
        "This server does not know which company owns the website (BUY_PAGE_TENANT_ID is not set), " +
        "so there is no website theme to change. Set BUY_PAGE_TENANT_ID and restart the server.",
    };
  }
  if (!input.tenantId || input.tenantId !== input.websiteTenantId) {
    return {
      ok: false,
      status: 403,
      error: "The website theme belongs to the company that owns the public website. This workspace does not have one.",
    };
  }
  if (input.role !== "owner") {
    return {
      ok: false,
      status: 403,
      error: "Only the workspace owner can change the website theme. Ask the owner to switch it in Settings → Branding.",
    };
  }
  return { ok: true };
}
