import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { campaignHtmlVars, campaignHtmlName } from "./campaign-html";

/* R-734: a lead's company / contact name comes from a public form or Lead Finder — in the HTML
   mail it must be text, never markup sent from our domain. */
const EVIL = `<a href="https://evil.example">x</a>`;

describe("R-734 — campaign HTML mail escapes every merge value", () => {
  it("every {{var}} value is escaped for HTML", () => {
    const v = campaignHtmlVars({ name: EVIL, company: EVIL, pitch: "a & b", offer_code: "X'1" });
    expect(v.company).toBe("&lt;a href=&quot;https://evil.example&quot;&gt;x&lt;/a&gt;");
    expect(v.name).not.toContain("<");
    expect(v.pitch).toBe("a &amp; b");
    expect(v.offer_code).toBe("X&#39;1");
  });

  it("the contact name used by {{name}} is escaped; no name stays null", () => {
    expect(campaignHtmlName(`Dr. <b>Kopal</b>`)).toBe("Dr. &lt;b&gt;Kopal&lt;/b&gt;");
    expect(campaignHtmlName(null)).toBeNull();
  });

  it("the send route builds the HTML from the escaped values", () => {
    const s = readFileSync(join(process.cwd(), "src/app/api/campaigns/send/route.ts"), "utf8");
    expect(s).toMatch(/campaignHtmlVars\(vars\)/);
    expect(s).toMatch(/fillName\(htmlTemplate, campaignHtmlName\(r\.contact_name\)\)/);
  });
});
