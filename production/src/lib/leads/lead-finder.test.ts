import { describe, it, expect } from "vitest";
import {
  normaliseDomain, parseDiscovery, mxProvider, siteNote, baselineScore, mergeScores, discoveryPrompt, leadNotes, splitList, spreadByIndustryCity, cleanPitch, type ScoreInput,
} from "./lead-finder";

const site = (over: Partial<ReturnType<typeof siteNote>> = {}) => ({ https: true, status: 200, note: "Site OK", ...over });
const input = (over: Partial<ScoreInput> = {}): ScoreInput => ({ company: "Acme Pvt Ltd", domain: "acme.co.in", city: "Gurgaon", description: null, mx: "zoho", site: site(), products: ["workspace", "website"], ...over });

describe("lead finder", () => {
  it("normalises domains and refuses free-mail / marketplace ones", () => {
    expect(normaliseDomain("https://www.Example.co.in/about?x=1")).toBe("example.co.in");
    expect(normaliseDomain("gmail.com")).toBeNull();
    expect(normaliseDomain("not a domain")).toBeNull();
  });

  it("parses a grounded answer with prose and fences, dedupes by domain", () => {
    const text = 'Here you go:\n```json\n[{"company":"Acme","domain":"www.acme.co.in","city":"Gurgaon"},{"company":"Acme again","domain":"acme.co.in"},{"company":"","domain":"x.com"},{"company":"Free","domain":"gmail.com"}]\n```';
    const out = parseDiscovery(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ company: "Acme", domain: "acme.co.in", website: "https://acme.co.in", city: "Gurgaon" });
    expect(parseDiscovery("no json here")).toEqual([]);
  });

  it("reads the mail provider off MX hosts", () => {
    expect(mxProvider(["10 aspmx.l.google.com."])).toBe("google");
    expect(mxProvider(["10 mx.zoho.in."])).toBe("zoho");
    expect(mxProvider(["0 acme-co-in.mail.protection.outlook.com."])).toBe("microsoft");
    expect(mxProvider(["10 mail.acme.co.in."])).toBe("cpanel");
    expect(mxProvider([])).toBe("none");
    expect(mxProvider(null)).toBe("unknown");
  });

  it("website audit reads SSL and stack", () => {
    expect(siteNote({ httpsOk: false, httpOk: false, status: null }).note).toBe("Site down");
    expect(siteNote({ httpsOk: false, httpOk: true, status: 200 }).note).toBe("No SSL");
    expect(siteNote({ httpsOk: true, httpOk: true, status: 200, generator: "WordPress 4.9", title: "Acme" }).note).toBe("Old WordPress");
    expect(siteNote({ httpsOk: true, httpOk: true, status: 200, generator: "Wix.com Website Builder", title: "Acme" }).note).toMatch(/builder/);
  });

  it("baseline score: no Workspace + no SSL is a strong lead; already on Workspace is weak", () => {
    const strong = baselineScore(input({ mx: "none", site: site({ https: false, status: 200, note: "Sirf HTTP" }) }));
    expect(strong.score).toBe(80);
    expect(strong.product).toBe("workspace");
    expect(strong.fit_reason).toMatch(/no email on the domain/);
    const weak = baselineScore(input({ mx: "google" }));
    expect(weak.score).toBe(25);
    const web = baselineScore(input({ mx: "google", site: site({ https: false, status: null, note: "x" }) }));
    expect(web.product).toBe("website");
  });

  it("merge keeps the AI within ±20 of the baseline and drops pitches with prices", () => {
    const items = [input()];
    const base = [baselineScore(items[0])];   // zoho → 60
    const merged = mergeScores(items, base, [{ domain: "acme.co.in", score: 99, product: "website", fit_reason: "Zoho par hai", pitch: "Sirf ₹99 mein Workspace" }]);
    expect(merged[0].score).toBe(80);
    expect(merged[0].product).toBe("website");
    expect(merged[0].fit_reason).toBe("Zoho par hai");
    expect(merged[0].pitch).toBe(base[0].pitch);            // price → baseline pitch
    expect(mergeScores(items, base, "garbage")).toEqual(base);
  });

  it("discovery prompt carries the profile and the exclusions", () => {
    const p = discoveryPrompt({ name: "x", cities: "Gurgaon", industries: "CA firms", company_size: "10-50", products: ["workspace"], must_have: "", exclude: "MNC", daily_limit: 10 }, ["known.com"], 10);
    expect(p.user).toContain("Gurgaon"); expect(p.user).toContain("CA firms"); expect(p.user).toContain("known.com"); expect(p.user).toContain("Exclude: MNC");
    expect(p.system).toMatch(/Do not use Google Maps/);
  });

  it("multi-city, multi-industry profile asks for a spread and names each value", () => {
    const p = discoveryPrompt({ name: "x", cities: "Gurgaon, Noida", industries: "dental clinics, diagnostic labs, play schools", company_size: "5-100", products: ["workspace"], must_have: "", exclude: "", daily_limit: 10 }, [], 24);
    expect(p.user).toContain("Cities (all of them): Gurgaon | Noida");
    expect(p.user).toContain("Industries (all of them): dental clinics | diagnostic labs | play schools");
    expect(p.user).toMatch(/cover EVERY city and EVERY industry/);
    expect(p.system).toContain("industry");
  });

  it("splitList handles commas, slashes and 'and'", () => expect(splitList("Gurgaon, Noida / Delhi and Faridabad")).toEqual(["Gurgaon", "Noida", "Delhi", "Faridabad"]));

  it("spreadByIndustryCity mixes a lopsided answer", () => {
    const dental = Array.from({ length: 6 }, (_, i) => ({ id: "d" + i, industry: "dental clinics", city: i % 2 ? "Noida" : "Gurgaon" }));
    const labs = [{ id: "l0", industry: "diagnostic labs", city: "Noida" }, { id: "l1", industry: "diagnostic labs", city: "Gurgaon" }];
    const school = [{ id: "s0", industry: "play schools", city: "Gurgaon" }];
    const first4 = spreadByIndustryCity([...dental, ...labs, ...school]).slice(0, 4).map((x) => x.industry);
    expect(new Set(first4)).toEqual(new Set(["dental clinics", "diagnostic labs", "play schools"]));
    const dentalOrder = spreadByIndustryCity(dental).slice(0, 2).map((x) => x.city);
    expect(new Set(dentalOrder)).toEqual(new Set(["Gurgaon", "Noida"]));
  });

  it("lead notes list the signals", () => {
    expect(leadNotes({ fit_reason: "r", pitch: "p", mx_provider: "zoho", site_note: "ok", source_url: "https://s", description: null })).toBe("AI Lead Finder\nWhy: r\nEmail: Zoho Mail\nWebsite: ok\nPitch: p\nSource: https://s");
  });
});

describe("cleanPitch", () => {
  it.each([
    ["Namaste! Shree Dental Clinic ke patient records ke liye Workspace lein.", "Shree Dental Clinic ke patient records ke liye Workspace lein."],
    ["Sir, algindia.com ke liye Workspace sabse secure hai.", "Algindia.com ke liye Workspace sabse secure hai."],
    ["Namaste ji, Hello! aapki clinic Gmail par hai.", "Aapki clinic Gmail par hai."],
    ["Aapki site par SSL nahi hai.", "Aapki site par SSL nahi hai."],
    ["Hindustan Times mein aapka naam aaya — Workspace se team fast hogi.", "Hindustan Times mein aapka naam aaya — Workspace se team fast hogi."],
  ])("%s", (raw, want) => expect(cleanPitch(raw)).toBe(want));
  it("empty stays empty", () => { expect(cleanPitch(null)).toBe(""); expect(cleanPitch("Namaste!")).toBe(""); });
});
