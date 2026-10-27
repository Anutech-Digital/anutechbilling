/**
 * R-1822 (24 Oct 2026) — one copy of every Radix package.
 *
 * Radix keeps its layer stack (which dropdown/dialog is on top, who handles Esc, who owns
 * body pointer-events) in module-level state inside @radix-ui/react-dismissable-layer and
 * friends. When react-menu/select/popover/tooltip bundled dismissable-layer 1.1.11 and
 * react-dialog 1.1.19, each had its own stack: one Esc closed both the dropdown and the
 * dialog, and a modal dropdown left body pointer-events:none behind — the page froze until
 * reload (R-1427, R-1692, R-1799).
 *
 * Fix: every direct @radix-ui/react-* dep in package.json is on the same Radix release
 * (24 Jul 2026 — dialog 1.1.23 / dismissable-layer 1.1.19), and package.json "overrides"
 * pins the few stateless helpers that cmdk and Prisma Studio's react-toggle asked for in
 * older versions. When bumping ONE Radix package, bump them all to the same release day on
 * npm, update those overrides, then run `npm ls @radix-ui/react-dismissable-layer`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type LockPackage = { version?: string };
const lock = JSON.parse(readFileSync(join(__dirname, "..", "package-lock.json"), "utf8")) as {
  packages: Record<string, LockPackage>;
};

/** Internals whose copies hold shared module state — two copies = the freeze/Esc bug. */
const STATEFUL = [
  "@radix-ui/react-dismissable-layer",
  "@radix-ui/react-focus-scope",
  "@radix-ui/react-focus-guards",
  "@radix-ui/react-portal",
  "@radix-ui/react-presence",
  "@radix-ui/react-popper",
  "@radix-ui/react-context",
  "@radix-ui/react-id",
];

/** name → version → lockfile paths, for every @radix-ui package in package-lock.json. */
function radixCopies(): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  for (const [path, pkg] of Object.entries(lock.packages)) {
    const at = path.lastIndexOf("node_modules/");
    if (at < 0 || !pkg.version) continue;
    const name = path.slice(at + "node_modules/".length);
    if (!name.startsWith("@radix-ui/")) continue;
    const byVersion = out.get(name) ?? new Map<string, string[]>();
    byVersion.set(pkg.version, [...(byVersion.get(pkg.version) ?? []), path]);
    out.set(name, byVersion);
  }
  return out;
}

function twoVersions(names?: string[]): string[] {
  const dupes: string[] = [];
  for (const [name, byVersion] of radixCopies()) {
    if (names && !names.includes(name)) continue;
    if (byVersion.size > 1) {
      dupes.push(`${name}: ${[...byVersion].map(([v, where]) => `${v} (${where.join(", ")})`).join(" | ")}`);
    }
  }
  return dupes;
}

describe("R-1822 one copy of Radix in package-lock.json", () => {
  it("the shared-state internals (dismissable-layer, focus-scope, portal, presence, popper…) have one version", () => {
    expect(twoVersions(STATEFUL)).toEqual([]);
  });

  it("every @radix-ui package has one version", () => {
    expect(twoVersions()).toEqual([]);
  });

  it("every @radix-ui package is installed once (no nested copy, even of the same version)", () => {
    const installedTwice = [...radixCopies()]
      .filter(([, byVersion]) => [...byVersion.values()].flat().length > 1)
      .map(([name, byVersion]) => `${name}: ${[...byVersion.values()].flat().join(", ")}`);
    expect(installedTwice).toEqual([]);
  });

  it("reads a real lockfile (dismissable-layer and focus-scope are present)", () => {
    const copies = radixCopies();
    expect(copies.get("@radix-ui/react-dismissable-layer")?.size).toBe(1);
    expect(copies.get("@radix-ui/react-focus-scope")?.size).toBe(1);
  });
});
