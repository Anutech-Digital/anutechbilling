/**
 * R-233 (6 Oct 2026): a hosting or domain customer who pressed "Log in" on the Anutech site
 * landed on /login — the ResellerOS STAFF sign-in. The header button, the mobile menu row,
 * the utility bar and the /done page all did it; only the footer's "Client area" used the
 * customer panel (CLIENT_AREA_URL). Rule: customer-facing chrome opens CLIENT_AREA_URL, and
 * a link to /login is labelled as the ResellerOS login.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const code = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const header = code("src/site/components/chrome/Header.tsx");
const chrome = code("src/site/components/chrome/Chrome.tsx");
const done = code("src/app/(marketing)/done/page.tsx");

describe("customer login on the Anutech site", () => {
  it("never calls the staff app 'Log in to ResellerOS' in the site chrome", () => {
    for (const c of [header, chrome, done]) expect(c).not.toMatch(/Log in to ResellerOS/);
    expect(chrome).not.toMatch(/Client login/);
    expect(done).not.toMatch(/Go to client login/);
  });

  it("the header button and the mobile menu row open the customer panel", () => {
    expect(header).toMatch(/href=\{CLIENT_AREA_URL as never\} className="btn btn-sm hide-mobile" aria-label="Customer login \(hosting & domains\)"/);
    expect(header).toMatch(/href=\{CLIENT_AREA_URL as never\}[^>]*>\s*Customer login \(hosting &amp; domains\) →/);
  });

  it("the utility bar opens the customer panel", () => {
    expect(chrome).toMatch(/<Link href=\{CLIENT_AREA_URL as never\}>Customer login<\/Link>/);
  });

  it("/done opens the customer panel", () => {
    expect(done).toMatch(/href=\{CLIENT_AREA_URL as never\}[^>]*>Customer login \(hosting &amp; domains\)</);
  });

  it("every remaining /login link in the chrome is the ResellerOS sign-in, named as such", () => {
    // header: only the ResellerOS menu promo ("Already have an account? Log in")
    const headerLogins = header.match(/href="\/login"[^>]*>[^<]*</g) ?? [];
    expect(headerLogins).toEqual([expect.stringMatching(/Already have an account\? Log in/)]);
    // footer: labelled ResellerOS login
    expect(chrome).toMatch(/\["ResellerOS login", "\/login"\]/);
    expect(chrome).not.toMatch(/<Link href="\/login">/);
  });
});
