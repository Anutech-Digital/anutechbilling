/**
 * R-1897 — Co-pilot Step 3 rules (copy-set.ts). Owner examples (Pardeep, 25 Oct):
 *   1. "Diwali Workspace" plan, Google + Meta, lead_gen, Main audience + lookalike on Meta.
 *      AI writes the full set; the person edits one headline to 31 characters → counter red,
 *      and "Mark ready" stays blocked until the line fits again.
 *   2. "Rewrite this line" on headline 4 changes ONLY headline 4.
 *   3. A kept (locked) headline survives a new "Write copy with AI".
 */
import { describe, expect, it } from "vitest";
import { fieldSpec } from "./channel-specs";
import {
  audienceBlocks, counterTone, emptySet, fromRows, mergeAi, pinOptions, readyCheck, replaceLine,
  setProgress, toRows, type CopySet,
} from "./copy-set";

let n = 0;
const key = () => `k${++n}`;

const googleAi = [
  { field: "headline", lines: Array.from({ length: 15 }, (_, i) => `Workspace headline ${i + 1}`) },
  { field: "description", lines: Array.from({ length: 4 }, (_, i) => `Google Workspace set up by our own Delhi team, option ${i + 1}.`) },
  { field: "path", lines: ["workspace", "diwali"] },
];
const metaAi = [
  { field: "primary_text", lines: ["This Diwali, move your office email to Google Workspace with our Delhi team.", "Second primary text for Workspace, written for Delhi SMEs this Diwali.", "Third primary text: setup, migration and support by our own team."] },
  { field: "headline", lines: ["Workspace for Diwali", "Email that just works", "Talk to our team"] },
  { field: "description", lines: ["Setup + migration included"] },
  { field: "cta", lines: ["GET_QUOTE"] },
];

const google = () => mergeAi(emptySet("google-ads", "generic", "search"), googleAi, key);
const meta = () => mergeAi(emptySet("meta-ads", "generic", "feed_image"), metaAi, key);

describe("audience blocks — one block per platform and audience", () => {
  it("Google gets the main audience; Meta also the lookalike when it is on", () => {
    expect(audienceBlocks(["google-ads", "meta-ads"], "lead_gen", true)).toEqual([
      { platform: "google-ads", format: "search", audience: "generic", label: "Main audience" },
      { platform: "meta-ads", format: "feed_image", audience: "generic", label: "Main audience" },
      { platform: "meta-ads", format: "feed_image", audience: "lookalike", label: "People like my customers" },
    ]);
    expect(audienceBlocks(["meta-ads"], "lead_gen", false).map((b) => b.audience)).toEqual(["generic"]);
  });

  it("the format follows the objective (sales on Google = Performance Max)", () => {
    expect(audienceBlocks(["google-ads"], "sales", false)[0].format).toBe("performance_max");
    expect(audienceBlocks(["google-ads"], "awareness", false)).toEqual([]);
  });
});

describe("Write copy with AI → a full set", () => {
  it("Google: 15 headlines and 4 descriptions, every one inside its limit", () => {
    const s = google();
    expect(s.lines.headline).toHaveLength(15);
    expect(s.lines.description).toHaveLength(4);
    expect(s.lines.headline.every((l) => l.text.length <= 30 && l.ai)).toBe(true);
    expect(setProgress(s).complete).toBe(true);
  });

  it("Meta: 3 primary texts, 3 headlines, a description and a CTA", () => {
    const s = meta();
    expect(s.lines.primary_text).toHaveLength(3);
    expect(s.lines.headline).toHaveLength(3);
    expect(s.lines.description).toHaveLength(1);
    expect(s.lines.cta.map((l) => l.text)).toEqual(["GET_QUOTE"]);
    expect(setProgress(s).complete).toBe(true);
  });

  it("a kept (locked) line survives a new AI run; unlocked lines are replaced", () => {
    let s = google();
    const kept = s.lines.headline[2];
    s = { ...s, lines: { ...s.lines, headline: s.lines.headline.map((l) => (l.key === kept.key ? { ...l, locked: true, text: "Kept headline" } : l)) } };
    const again = mergeAi(s, [{ field: "headline", lines: Array.from({ length: 15 }, (_, i) => `New headline ${i + 1}`) }], key);
    expect(again.lines.headline).toHaveLength(15);
    expect(again.lines.headline.filter((l) => l.text === "Kept headline")).toHaveLength(1);
    expect(again.lines.headline.find((l) => l.text === "Kept headline")!.locked).toBe(true);
    expect(again.lines.headline.some((l) => l.text === "Workspace headline 1")).toBe(false);
    // fields the AI did not return are left alone
    expect(again.lines.description).toEqual(s.lines.description);
  });

  it("never adds a line that repeats a kept line, never goes over the platform's count", () => {
    let s = google();
    s = { ...s, lines: { ...s.lines, headline: s.lines.headline.map((l, i) => (i === 0 ? { ...l, locked: true } : l)) } };
    const again = mergeAi(s, [{ field: "headline", lines: ["workspace HEADLINE 1", ...Array.from({ length: 20 }, (_, i) => `Fresh ${i}`)] }], key);
    expect(again.lines.headline).toHaveLength(15);
    expect(again.lines.headline.filter((l) => l.text.toLowerCase() === "workspace headline 1")).toHaveLength(1);
  });
});

describe("Rewrite this line — only that line changes", () => {
  it("replaces one line's text and keeps every other line and its place", () => {
    const s = google();
    const target = s.lines.headline[3];
    const out = replaceLine(s, "headline", target.key, "Fresh rewrite here");
    expect(out.lines.headline[3]).toMatchObject({ key: target.key, text: "Fresh rewrite here", ai: true });
    out.lines.headline.forEach((l, i) => { if (i !== 3) expect(l).toEqual(s.lines.headline[i]); });
    expect(out.lines.description).toEqual(s.lines.description);
  });

  it("an unknown line key changes nothing", () => {
    const s = google();
    expect(replaceLine(s, "headline", "nope", "x")).toEqual(s);
  });
});

describe("counter — red when over the limit", () => {
  const hl = fieldSpec("google-ads", "search", "headline")!;
  const metaHl = fieldSpec("meta-ads", "feed_image", "headline")!;
  it("Google headline: 30 fits, 31 is over (blocks)", () => {
    expect(counterTone("a".repeat(30), hl)).toMatchObject({ tone: "ok", label: "30/30", blocks: false });
    expect(counterTone("a".repeat(31), hl)).toMatchObject({ tone: "over", label: "31/30", blocks: true });
  });
  it("Meta headline: over the recommendation is red but does not block", () => {
    expect(counterTone("a".repeat(28), metaHl)).toMatchObject({ tone: "over", label: "28/27", blocks: false });
  });
});

describe("Mark ready — every chosen platform needs one full set", () => {
  it("blocked with plain reasons until each platform has a full set", () => {
    const g = google();
    const r1 = readyCheck(["google-ads", "meta-ads"], "lead_gen", [g]);
    expect(r1.ok).toBe(false);
    expect(r1.missing.join(" ")).toMatch(/Meta/);

    const r2 = readyCheck(["google-ads", "meta-ads"], "lead_gen", [g, meta()]);
    expect(r2).toEqual({ ok: true, missing: [] });
  });

  it("a Google headline over 30 characters blocks it and says which", () => {
    const g = google();
    const bad = replaceLine(g, "headline", g.lines.headline[0].key, "a".repeat(31));
    const r = readyCheck(["google-ads"], "lead_gen", [bad]);
    expect(r.ok).toBe(false);
    expect(r.missing[0]).toMatch(/Google Ads.*headline.*over 30/i);
  });

  it("too few lines says how many more", () => {
    const g = google();
    const few: CopySet = { ...g, lines: { ...g.lines, headline: g.lines.headline.slice(0, 2), description: [] } };
    const p = setProgress(few);
    expect(p.complete).toBe(false);
    expect(p.missing).toEqual(["1 more headline", "2 more descriptions"]);
  });

  it("Meta without a CTA is not complete", () => {
    const m = meta();
    expect(setProgress({ ...m, lines: { ...m.lines, cta: [] } }).missing).toContain("a call-to-action button");
  });

  it("one full audience block per platform is enough (lookalike may stay empty)", () => {
    const r = readyCheck(["meta-ads"], "lead_gen", [meta(), emptySet("meta-ads", "lookalike", "feed_image")]);
    expect(r.ok).toBe(true);
  });

  it("no platforms → not ready", () => {
    expect(readyCheck([], "lead_gen", []).ok).toBe(false);
  });
});

describe("rows ↔ set (what autosave stores in ad_copies)", () => {
  it("round-trips text, order, keep and pin", () => {
    const g = google();
    const pinned = { ...g, lines: { ...g.lines, headline: g.lines.headline.map((l, i) => (i === 0 ? { ...l, pinned: 1, locked: true } : l)) } };
    const rows = toRows(pinned);
    expect(rows.filter((r) => r.field === "headline").map((r) => r.position)).toEqual([...Array(15).keys()]);
    expect(rows[0]).toMatchObject({ platform: "google-ads", audience: "generic", format: "search", field: "headline", pinned: 1, locked: true });
    const back = fromRows("google-ads", "generic", "search", rows, 3, key);
    expect(back.version).toBe(3);
    expect(back.lines.headline.map((l) => [l.text, l.pinned, l.locked])).toEqual(pinned.lines.headline.map((l) => [l.text, l.pinned, l.locked]));
  });

  it("blank lines are not stored", () => {
    const g = google();
    const s = replaceLine(g, "headline", g.lines.headline[0].key, "   ");
    expect(toRows(s).filter((r) => r.field === "headline")).toHaveLength(14);
  });
});

describe("pin choices (Google only)", () => {
  it("headlines 1–3, descriptions 1–2, nothing on Meta", () => {
    expect(pinOptions("google-ads", "headline")).toEqual([1, 2, 3]);
    expect(pinOptions("google-ads", "description")).toEqual([1, 2]);
    expect(pinOptions("google-ads", "path")).toEqual([]);
    expect(pinOptions("meta-ads", "headline")).toEqual([]);
  });
});
