/**
 * R-1876 — the ad-copy writer's rules, without any AI: which fields each channel needs, what
 * the AI is asked, and the server-side check every line passes before a person sees it.
 */
import { describe, expect, it } from "vitest";
import {
  applyShortened, buildCopyPrompt, collectCandidates, copySlots, finalizeCopy, mayWriteCopy,
  needsShortening, slotKey, stubCopy, type CopyBrief,
} from "./copy-prompt";

const brief = (over: Partial<CopyBrief> = {}): CopyBrief => ({
  brand: "Anutech Digital",
  product: "Google Workspace Business Starter",
  objective: "lead_gen",
  platforms: ["google-ads", "meta-ads"],
  tone: "friendly, expert",
  language: "en",
  brief: "Diwali offer for Delhi SMEs moving email to Google Workspace",
  ...over,
});

describe("mayWriteCopy", () => {
  it("owner, manager and marketing only", () => {
    expect(mayWriteCopy("owner")).toBe(true);
    expect(mayWriteCopy("manager")).toBe(true);
    expect(mayWriteCopy("marketing")).toBe(true);
    for (const r of ["sales", "billing", "accountant", "support", null, undefined, ""]) expect(mayWriteCopy(r)).toBe(false);
  });
});

describe("copySlots", () => {
  it("lead_gen: Google search (15 headlines ≤30, 4 descriptions ≤90, 2 paths) + Meta feed", () => {
    const { slots, skipped } = copySlots(["google-ads", "meta-ads"], "lead_gen");
    expect(skipped).toEqual([]);
    const g = slots.filter((s) => s.platform === "google-ads");
    expect(g.map((s) => [s.format, s.field.key, s.want])).toEqual([
      ["search", "headline", 15], ["search", "description", 4], ["search", "path", 2],
    ]);
    const m = slots.filter((s) => s.platform === "meta-ads");
    expect(m.map((s) => [s.format, s.field.key, s.want])).toEqual([
      ["feed_image", "primary_text", 1], ["feed_image", "headline", 1],
    ]);
  });

  it("sales on Google = Performance Max; business name comes from the brand, not the AI", () => {
    const { slots } = copySlots(["google-ads"], "sales");
    expect(slots.every((s) => s.format === "performance_max")).toBe(true);
    const bn = slots.find((s) => s.field.key === "business_name")!;
    expect(bn.fromBrand).toBe(true);
  });

  it("awareness on Google is skipped with a reason (no Display/Video specs yet)", () => {
    const { slots, skipped } = copySlots(["google-ads", "meta-ads"], "awareness");
    expect(slots.every((s) => s.platform === "meta-ads")).toBe(true);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].platform).toBe("google-ads");
    expect(skipped[0].reason).toMatch(/awareness/i);
  });
});

describe("buildCopyPrompt", () => {
  it("names every slot with its count and limit, the brand voice and language", () => {
    const { slots } = copySlots(["google-ads", "meta-ads"], "lead_gen");
    const p = buildCopyPrompt(brief({ language: "hinglish" }), slots);
    expect(p.user).toContain("Anutech Digital");
    expect(p.user).toContain("Google Workspace Business Starter");
    expect(p.user).toContain("friendly, expert");
    expect(p.user).toMatch(/Hinglish/);
    expect(p.user).toMatch(/google-ads\.search\.headline: 15 lines, each at most 30 characters/);
    expect(p.user).toMatch(/meta-ads\.feed_image\.headline: 1 line, ideally at most 27 characters/);
    expect(p.system).toMatch(/JSON/);
    expect(p.system).toMatch(/never invent a price/i);
  });

  it("without a tone, falls back to the default voice", () => {
    const { slots } = copySlots(["meta-ads"], "traffic");
    expect(buildCopyPrompt(brief({ tone: null }), slots).user).toMatch(/clear, friendly and professional/);
  });
});

describe("collect → shorten → finalize", () => {
  const { slots } = copySlots(["google-ads", "meta-ads"], "lead_gen");
  const H = slotKey("google-ads", "search", "headline");

  it("cleans, de-duplicates (case/space-insensitive) and caps the count", () => {
    const raw = {
      "google-ads": {
        search: {
          headline: ['"Workspace for Diwali"', "workspace  for diwali", "Email that just works", 42, "", ...Array.from({ length: 20 }, (_, i) => `Headline ${i}`)],
        },
      },
    };
    const c = collectCandidates(raw, slots, brief());
    const h = c.get(H)!;
    expect(h[0]).toBe("Workspace for Diwali");
    expect(h.filter((x) => x.toLowerCase() === "workspace for diwali")).toHaveLength(1);
    expect(h).not.toContain("");
    expect(h.length).toBe(15);
  });

  it("over-limit lines are listed for ONE shorten retry; still over after it → dropped with a reason", () => {
    const long = "Move your whole office email to Google Workspace today"; // 54 > 30
    const raw = { "google-ads": { search: { headline: ["Workspace for Diwali", long, "Email that just works"] } } };
    const c = collectCandidates(raw, slots, brief());
    const todo = needsShortening(c, slots);
    expect(todo).toEqual([{ id: `${H}#1`, text: long, limit: 30 }]);

    const after = applyShortened(c, [{ id: `${H}#1`, text: "Still far too long for a Google headline" }]);
    const res = finalizeCopy(after, slots, []);
    const f = res.find((r) => r.platform === "google-ads" && r.field === "headline")!;
    expect(f.lines.map((l) => l.text)).toEqual(["Workspace for Diwali", "Email that just works"]);
    expect(f.lines.every((l) => l.ok && l.length <= 30)).toBe(true);
    expect(f.dropped).toEqual([{ text: "Still far too long for a Google headline", reason: "Longer than 30 characters" }]);
    expect(f.short).toBe(true); // 2 < 3 headlines needed
  });

  it("a shortened line that fits replaces the long one", () => {
    const long = "Move your whole office email to Google Workspace today";
    const c = collectCandidates({ "google-ads": { search: { headline: [long] } } }, slots, brief());
    const after = applyShortened(c, [{ id: `${H}#0`, text: "Office email on Workspace" }]);
    const f = finalizeCopy(after, slots, []).find((r) => r.field === "headline" && r.platform === "google-ads")!;
    expect(f.lines.map((l) => l.text)).toEqual(["Office email on Workspace"]);
    expect(f.dropped).toEqual([]);
  });

  it("Meta has only a RECOMMENDED length: a long line is kept but never marked ok", () => {
    const long = "A".repeat(160);
    const c = collectCandidates({ "meta-ads": { feed_image: { primary_text: [long], headline: ["Workspace for Diwali offer"] } } }, slots, brief());
    const res = finalizeCopy(c, slots, []);
    const p = res.find((r) => r.platform === "meta-ads" && r.field === "primary_text")!;
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ ok: false, kind: "recommended", limit: 150, length: 160 });
    const h = res.find((r) => r.platform === "meta-ads" && r.field === "headline")!;
    expect(h.lines[0]).toMatchObject({ ok: true, kind: "recommended", limit: 27 });
  });

  it("money guard: a ₹ figure the person did not type is dropped; one they typed is kept", () => {
    const raw = { "google-ads": { search: { headline: ["Workspace at ₹99", "Workspace at ₹136", "Email that just works"] } } };
    const c = collectCandidates(raw, slots, brief());
    const f = finalizeCopy(c, slots, [136]).find((r) => r.field === "headline" && r.platform === "google-ads")!;
    expect(f.lines.map((l) => l.text)).toEqual(["Workspace at ₹136", "Email that just works"]);
    expect(f.dropped).toEqual([{ text: "Workspace at ₹99", reason: "Mentions a price you did not give (₹99)" }]);
  });

  it("business name comes from the brand; a brand over 25 characters is dropped with a reason", () => {
    const { slots: pm } = copySlots(["google-ads"], "sales");
    const ok = finalizeCopy(collectCandidates({}, pm, brief()), pm, []).find((r) => r.field === "business_name")!;
    expect(ok.lines.map((l) => l.text)).toEqual(["Anutech Digital"]);
    const long = finalizeCopy(collectCandidates({}, pm, brief({ brand: "Anutech Digital Private Limited India" })), pm, [])
      .find((r) => r.field === "business_name")!;
    expect(long.lines).toEqual([]);
    expect(long.dropped[0].reason).toBe("Longer than 25 characters");
  });

  it("no line anywhere in a finished result is over a hard maximum", () => {
    const { slots: all } = copySlots(["google-ads", "meta-ads"], "sales");
    const noisy = {
      "google-ads": { performance_max: { headline: ["x".repeat(31), "ok"], long_headline: ["y".repeat(91)], description: ["z".repeat(95), "fine"] } },
    };
    for (const f of finalizeCopy(collectCandidates(noisy, all, brief()), all, [])) {
      if (f.max == null) continue;
      for (const l of f.lines) expect([...l.text].length).toBeLessThanOrEqual(f.max);
    }
  });
});

describe("stubCopy (no AI key)", () => {
  it("a long product name still gives all 15 Google headlines (localhost showed 13 before the spares)", () => {
    const { slots } = copySlots(["google-ads"], "lead_gen");
    const b = brief({ brand: "E2E Test Co", product: "Google Workspace Business Starter" });
    const f = finalizeCopy(collectCandidates(stubCopy(b, slots), slots, b), slots, [])
      .find((r) => r.field === "headline")!;
    expect(f.lines).toHaveLength(15);
  });

  it("fills every slot inside its limit, Google headlines unique, at least the minimum", () => {
    for (const objective of ["traffic", "lead_gen", "sales"] as const) {
      const { slots } = copySlots(["google-ads", "meta-ads"], objective);
      const b = brief({ objective });
      const res = finalizeCopy(collectCandidates(stubCopy(b, slots), slots, b), slots, []);
      for (const f of res) {
        expect(f.dropped, `${objective} ${f.platform}.${f.field}`).toEqual([]);
        expect(f.short, `${objective} ${f.platform}.${f.field}`).toBe(false);
        for (const l of f.lines) if (f.max != null) expect(l.ok).toBe(true);
        const keys = f.lines.map((l) => l.text.toLowerCase());
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
  });
});
