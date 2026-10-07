/**
 * R-309 (7 Oct 2026) — the last nine pardeep-area files with untied labels / unnamed inputs
 * (Contacts, Documents, Help, Team, WhatsApp, Campaign composer, Task related-picker and the two
 * Contacts import dialogs), plus the bare error toasts in those two import dialogs (§24).
 *
 * Same counters as a11y-ratchet.test.tsx and toast-error-ratchet.test.ts, but per-file and at
 * ZERO so a new hit fails on the file it lands in. Kept in its own file so it never collides with
 * another worker extending the shared ratchets the same night.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
const { countRaw } = require("../../../scripts/count-raw-toast-errors.cjs");

type Hit = { file: string; kind: string; lines: number[] };
type Report = { detail: Record<string, Hit[]> };

const report = (): Report =>
  JSON.parse(execFileSync(process.execPath, [join(process.cwd(), "scripts", "a11y-count.mjs"), "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })) as Report;

const ZERO_FILES = [
  "app/(app)/contacts/page.tsx",
  "app/(app)/documents/page.tsx",
  "app/(app)/help/page.tsx",
  "app/(app)/team/page.tsx",
  "app/(app)/whatsapp/page.tsx",
  "components/features/campaigns/campaign-composer-dialog.tsx",
  "components/features/contacts/google-contacts-import-dialog.tsx",
  "components/features/contacts/import-contacts-dialog.tsx",
  "components/features/tasks/task-related-picker.tsx",
];

const TOAST_FILES = [
  "src/components/features/contacts/import-contacts-dialog.tsx",
  "src/components/features/contacts/google-contacts-import-dialog.tsx",
] as const;

describe("R-309 — these files have no untied label and no unnamed input", () => {
  const r = report();
  const all = Object.values(r.detail).flat();

  it("the counter sees the pages at all (denominator first)", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(ZERO_FILES)("%s", (file) => {
    const hits = all
      .filter((h) => h.file.split("\\").join("/").endsWith(file))
      .filter((h) => h.kind === "label-no-for" || h.kind === "input-no-name")
      .map((h) => `${h.kind}:${h.lines.join(",")}`);
    expect(hits).toEqual([]);
  });
});

describe("R-309 — Contacts import dialogs: no bare or raw error toasts", () => {
  const { total, rawByFile } = countRaw(join(process.cwd(), "src")) as {
    total: number;
    rawByFile: Map<string, number>;
  };

  it("the scan actually saw toasts (an empty scan must not pass)", () => {
    expect(total).toBeGreaterThan(100);
  });

  it.each(TOAST_FILES)("%s has 0 bare toast.error", (rel) => {
    const abs = join(process.cwd(), rel);
    const src = readFileSync(abs, "utf8");
    expect(src).toMatch(/toast\.error\(|toastError\(/);
    expect(rawByFile.get(abs) ?? 0).toBe(0);
  });

  it.each(TOAST_FILES)("%s never toasts raw error text", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/toast\.error\(\s*\(?\s*\w+\s+as\s+Error\s*\)?\s*\.message/);
    expect(src).not.toMatch(/toast\.error\(\s*\w+\s+instanceof\s+Error\s*\?\s*\w+\.message/);
    expect(src).not.toMatch(/toast\.error\(\s*\w+\.message/);
  });
});
