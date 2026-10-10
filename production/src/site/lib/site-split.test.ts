/**
 * R-520: the redirect map between anutech.in (company) and reselleros.anutech.in (ResellerOS).
 * Pins: every old company link answers a 301 to anutech.in (never a 404), the product host's
 * "/" is the ResellerOS homepage, no loop between the hosts, POSTs and transactional pages
 * are never redirected, and dev/staging hosts are untouched.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  COMPANY_ORIGIN, PRODUCT_ORIGIN, COMPANY_PATHS, PRODUCT_PATHS, SERVED_ON_BOTH,
  COMPANY_SITEMAP, PRODUCT_SITEMAP, PRODUCT_HOME_ROUTE,
  decideSite, siteKindForHost, lookupMoved, sitemapFor,
} from "./site-split";

const P = "reselleros.anutech.in";
const C = "anutech.in";
const APP = join(__dirname, "..", "..", "app");

/** Does a page.tsx exist for this URL path in any route group? (dynamic segments ignored) */
function pageExists(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  const groups = readdirSync(APP).filter((d) => /^\(.+\)$/.test(d));
  return groups.some((g) => existsSync(join(APP, g, ...segs, "page.tsx")));
}

/** Any page.tsx below this path (one or more levels), in any route group. */
function hasSubPage(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  const groups = readdirSync(APP).filter((d) => /^\(.+\)$/.test(d));
  return groups.some((g) => {
    const dir = join(APP, g, ...segs);
    if (!existsSync(dir)) return false;
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && existsSync(join(dir, e.name, "page.tsx")));
  });
}

describe("host detection", () => {
  it("knows both domains, ignores port, case and proxy lists", () => {
    expect(siteKindForHost("anutech.in")).toBe("company");
    expect(siteKindForHost("WWW.Anutech.in:443")).toBe("company");
    expect(siteKindForHost("reselleros.anutech.in")).toBe("product");
    expect(siteKindForHost("reselleros.anutech.in, 10.0.0.1")).toBe("product");
    expect(siteKindForHost("localhost:4320")).toBe("other");
    expect(siteKindForHost("staging-service.example")).toBe("other");
    expect(siteKindForHost(null)).toBe("other");
  });
});

describe("redirect map: reselleros.anutech.in → anutech.in", () => {
  it("every company path 301s to the same path on anutech.in", () => {
    for (const m of COMPANY_PATHS) {
      expect(m.to.startsWith(COMPANY_ORIGIN), m.from).toBe(true);
      expect(decideSite(P, m.from, "", "GET"), m.from).toEqual({ action: "redirect", location: m.to });
    }
  });

  it("keeps sub-paths, trailing slashes and the query string (UTM / gclid survive)", () => {
    expect(decideSite(P, "/email/compare-editions", "", "GET")).toEqual({ action: "redirect", location: `${COMPANY_ORIGIN}/email/compare-editions` });
    expect(decideSite(P, "/hosting/trial/", "", "GET")).toEqual({ action: "redirect", location: `${COMPANY_ORIGIN}/hosting/trial` });
    expect(decideSite(P, "/lp/google-workspace-1", "?gclid=abc&utm_source=g", "GET")).toEqual({
      action: "redirect", location: `${COMPANY_ORIGIN}/lp/google-workspace-1?gclid=abc&utm_source=g`,
    });
  });

  it("no old company link 404s: every target is a real page", () => {
    // exact entries are real pages; prefix entries (/google-workspace, /lp) are folders whose
    // pages live one level down — their sub-paths keep working after the move
    for (const m of COMPANY_PATHS) {
      const ok = pageExists(m.from) || (!!m.prefix && hasSubPage(m.from));
      expect(ok, m.from).toBe(true);
    }
    for (const m of PRODUCT_PATHS) expect(pageExists(m.from), m.from).toBe(true);
    expect(pageExists(PRODUCT_HOME_ROUTE)).toBe(true);
  });

  it("does not catch look-alike paths", () => {
    expect(decideSite(P, "/emails", "", "GET")).toEqual({ action: "serve" });
    expect(lookupMoved(COMPANY_PATHS, "/resellers")).toBeNull();
    // /reseller (wholesale program) is company; /reselleros is the product
    expect(decideSite(P, "/reseller", "", "GET")).toEqual({ action: "redirect", location: `${COMPANY_ORIGIN}/reseller` });
  });

  it("the product host's / is the ResellerOS homepage, and /reselleros folds into /", () => {
    expect(decideSite(P, "/", "", "GET")).toEqual({ action: "rewrite", pathname: PRODUCT_HOME_ROUTE });
    expect(decideSite(P, "/reselleros", "?utm_source=x", "GET")).toEqual({ action: "redirect", location: `${PRODUCT_ORIGIN}/?utm_source=x` });
  });

  it("app, sign-in, API and the product's own pages stay put", () => {
    for (const p of ["/login", "/signup", "/dashboard", "/api/version", "/pricing", "/about", "/privacy", "/terms", "/auth/callback"]) {
      expect(decideSite(P, p, "", "GET"), p).toEqual({ action: "serve" });
    }
  });
});

describe("redirect map: anutech.in → reselleros.anutech.in", () => {
  it("ResellerOS pages on the company host 301 to the product host", () => {
    expect(decideSite(C, "/reselleros", "", "GET")).toEqual({ action: "redirect", location: `${PRODUCT_ORIGIN}/` });
    expect(decideSite(C, "/pricing", "", "GET")).toEqual({ action: "redirect", location: `${PRODUCT_ORIGIN}/pricing` });
    for (const m of PRODUCT_PATHS) expect(m.to.startsWith(PRODUCT_ORIGIN), m.from).toBe(true);
  });

  it("company pages and the company home are served on anutech.in", () => {
    for (const p of ["/", "/domains", "/hosting", "/email", "/quote", "/lp/google-workspace-1"]) {
      expect(decideSite(C, p, "", "GET"), p).toEqual({ action: "serve" });
    }
  });
});

describe("failure cases", () => {
  it("no loop: a path is never moved by both maps", () => {
    for (const m of COMPANY_PATHS) expect(lookupMoved(PRODUCT_PATHS, m.from), m.from).toBeNull();
    for (const m of PRODUCT_PATHS) expect(lookupMoved(COMPANY_PATHS, m.from), m.from).toBeNull();
    // following any redirect once lands on a page that is served, not redirected again
    for (const m of [...COMPANY_PATHS, ...PRODUCT_PATHS]) {
      const u = new URL(m.to);
      const next = decideSite(u.host, u.pathname, "", "GET");
      expect(next.action === "redirect", m.from).toBe(false);
    }
  });

  it("POST (payment callbacks, forms) is never redirected", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(decideSite(P, "/domains", "", m), m).toEqual({ action: "serve" });
      expect(decideSite(C, "/pricing", "", m), m).toEqual({ action: "serve" });
    }
    expect(decideSite(P, "/domains", "", "HEAD").action).toBe("redirect");
  });

  it("transactional pages and the app's public links are served on both hosts", () => {
    for (const p of [...SERVED_ON_BOTH, "/buy/workspace", "/buy/workspace/thanks", "/quote/abc/accept", "/enquiry"]) {
      expect(decideSite(P, p, "", "GET"), p).toEqual({ action: "serve" });
      expect(decideSite(C, p, "", "GET"), p).toEqual({ action: "serve" });
    }
  });

  it("dev, staging and test hosts are never redirected", () => {
    for (const h of ["localhost:4320", "127.0.0.1:3000", "staging-service.example"]) {
      for (const p of ["/", "/domains", "/reselleros", "/pricing"]) {
        expect(decideSite(h, p, "", "GET"), `${h}${p}`).toEqual({ action: "serve" });
      }
    }
  });
});

describe("sitemap + canonical per domain", () => {
  it("each host gets its own origin and its own pages", () => {
    expect(sitemapFor(C).origin).toBe(COMPANY_ORIGIN);
    expect(sitemapFor(P).origin).toBe(PRODUCT_ORIGIN);
    expect(sitemapFor("localhost:4320").origin).toBe(PRODUCT_ORIGIN);
  });

  it("the product sitemap lists only ResellerOS pages; the company one no ResellerOS pages", () => {
    for (const s of PRODUCT_SITEMAP) {
      expect(lookupMoved(COMPANY_PATHS, s.path), s.path).toBeNull();
      expect(decideSite(P, s.path, "", "GET").action, s.path).not.toBe("redirect");
    }
    for (const s of COMPANY_SITEMAP) {
      expect(lookupMoved(PRODUCT_PATHS, s.path), s.path).toBeNull();
      expect(decideSite(C, s.path, "", "GET").action, s.path).not.toBe("redirect");
    }
    expect(COMPANY_SITEMAP.map((s) => s.path)).not.toContain("/reselleros");
  });

  it("every sitemap entry is a real page", () => {
    for (const s of [...COMPANY_SITEMAP, ...PRODUCT_SITEMAP]) {
      expect(s.path === "/" || pageExists(s.path), s.path).toBe(true);
    }
  });
});

describe("company canonical origin", () => {
  it("SITE_URL (company pages' canonical) is anutech.in when no env override", async () => {
    const { SITE_URL } = await import("./config");
    if (!process.env.NEXT_PUBLIC_SITE_URL) expect(SITE_URL).toBe(COMPANY_ORIGIN);
  });
});
