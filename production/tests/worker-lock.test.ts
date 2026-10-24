import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { normPath, pathsOverlap, tooBroad, findConflicts, queueFull, pushTurnFree, PUSH_TURN_STALE_MS, maxWorkersAt, reexportTarget, lockAreaFor, cardContractGaps, checkCardContract, parseCardFlags, managerCard, cardFromJson, TSC_STEPS, pushPlan, pushDoneLine, waitLine } from "../scripts/ops/worker-lock.mjs";

describe("worker locks (two workers must never build in the same files)", () => {
  it("compares paths from the app root, whatever the slashes", () => {
    expect(normPath("production\\src\\lib\\deals\\")).toBe("src/lib/deals");
    expect(normPath("./src/lib/x.ts")).toBe("src/lib/x.ts");
  });

  it("a folder overlaps the files inside it, but not a sibling with a longer name", () => {
    expect(pathsOverlap("src/lib/deals", "src/lib/deals/deal-rules.ts")).toBe(true);
    expect(pathsOverlap("src/lib/deals/deal-rules.ts", "src/lib/deals")).toBe(true);
    expect(pathsOverlap("src/lib/deal", "src/lib/deals")).toBe(false);
    expect(pathsOverlap("src/app/(app)/deals", "src/app/(app)/customers")).toBe(false);
  });

  it("refuses claims so broad they would lock every other worker out", () => {
    expect(tooBroad("src")).toBe(true);
    expect(tooBroad("src/app")).toBe(true);
    expect(tooBroad("src/lib/deals")).toBe(false);
    expect(tooBroad("scripts/ops")).toBe(true);
    expect(tooBroad(".")).toBe(true);
    expect(tooBroad("")).toBe(true);
    expect(tooBroad("*")).toBe(true);
    expect(tooBroad("src/*")).toBe(true);
    expect(tooBroad("src/lib/*.ts")).toBe(true);
    expect(tooBroad(".github")).toBe(true);
  });

  it("R-345: an exact FILE path is fine at any depth (root config files can be locked)", () => {
    expect(tooBroad("sentry.client.config.ts")).toBe(false);
    expect(tooBroad("production/next.config.ts")).toBe(false);
    expect(tooBroad("scripts/setup-cloud-scheduler.sh")).toBe(false);
    expect(tooBroad("tests/worker-lock.test.ts")).toBe(false);
    expect(tooBroad(".env.example")).toBe(false);
    expect(tooBroad("production\\package.json")).toBe(false);
  });

  it("names the other card and both paths on a conflict, and ignores its own lock", () => {
    const locks = [
      { card: "R-197", areas: ["src/app/(app)/deals"], files: [] },
      { card: "R-300", areas: ["src/lib/inbound"], files: ["src/lib/ai/app-help.ts"] },
    ];
    expect(findConflicts("R-197", ["src/app/(app)/deals/page.tsx"], locks)).toEqual([]);
    expect(findConflicts("R-301", ["src/app/(app)/deals/page.tsx"], locks)).toEqual([
      { card: "R-197", mine: "src/app/(app)/deals/page.tsx", theirs: "src/app/(app)/deals" },
    ]);
    expect(findConflicts("R-301", ["src/lib/ai/app-help.ts"], locks).map((c: { card: string }) => c.card)).toEqual(["R-300"]);
    expect(findConflicts("R-301", ["src/lib/customers"], locks)).toEqual([]);
  });

  it("lets at most 4 workers run, and a worker re-claiming its own card is not counted", () => {
    const four = ["R-1", "R-2", "R-3", "R-4"].map((card) => ({ card, areas: [], files: [] }));
    expect(queueFull("R-5", four.slice(0, 3), 4)).toBe(false);
    expect(queueFull("R-5", four, 4)).toBe(true);
    expect(queueFull("R-4", four, 4)).toBe(false);
    expect(queueFull("R-5", four, 8)).toBe(false);
  });

  it("one push at a time; a turn left by a crashed worker frees itself after 15 min", () => {
    const now = 1_000_000_000;
    expect(pushTurnFree(null, now)).toBe(true);
    expect(pushTurnFree({ card: "R-1", at: now - 60_000 }, now)).toBe(false);
    expect(pushTurnFree({ card: "R-1", at: now - PUSH_TURN_STALE_MS - 1 }, now)).toBe(true);
  });

  it("card prep: spots a page that only re-exports another (R-197's deals page)", () => {
    expect(reexportTarget('export { default } from "../leads/page";\n')).toBe("../leads/page");
    expect(reexportTarget("// deals = leads\nexport { default, metadata } from '@/app/(app)/leads/page';")).toBe("@/app/(app)/leads/page");
    expect(reexportTarget("export default function Page() { return null; }")).toBeNull();
    expect(reexportTarget('import x from "y";\nconst a = 1;\nexport { a } from "z";')).toBeNull();
  });

  it("card prep: a file's lock area is its folder; never broader than 3 parts", () => {
    expect(lockAreaFor("production/src/app/(app)/deals/page.tsx")).toBe("src/app/(app)/deals");
    expect(lockAreaFor("src/lib/nav.ts")).toBe("src/lib/nav.ts");
    expect(lockAreaFor("src/components/layout/topbar.tsx")).toBe("src/components/layout/topbar.tsx");
  });

  it("2 workers while Pardeep works (09:00–21:59 IST), 4 at night", () => {
    expect(maxWorkersAt("2026-10-07T03:30:00Z")).toBe(2); // 09:00 IST
    expect(maxWorkersAt("2026-10-07T16:29:00Z")).toBe(2); // 21:59 IST
    expect(maxWorkersAt("2026-10-07T16:30:00Z")).toBe(4); // 22:00 IST
    expect(maxWorkersAt("2026-10-06T21:00:00Z")).toBe(4); // 02:30 IST
  });
});

describe("R-842: board v76 card contract (claim/push refuse an incomplete card)", () => {
  const full = {
    id: "R-500", title: "x", kind: "bug", category: "billing", doneWhen: "invoice total right",
    triage: { verdict: "zaroori", why: "customer ko galat bill", at: "2026-10-11T07:00:00Z" },
    howToCheck: "1. /invoices kholo 2. total dekho",
  };
  const file = (card: unknown) => () => JSON.stringify(card);
  const flags = { cardPath: "card.json", noCheck: false };

  it("missing kind → claim refused, naming the field", () => {
    const { kind: _k, ...noKind } = full;
    const r = checkCardContract("R-500", "claim", flags, file(noKind));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("kind");
    expect(cardContractGaps(noKind, "claim")).toEqual(["kind"]);
  });

  it("full card → claim and push ok", () => {
    expect(checkCardContract("R-500", "claim", flags, file(full)).ok).toBe(true);
    expect(checkCardContract("R-500", "push", flags, file(full)).ok).toBe(true);
  });

  it("missing howToCheck → push refused (claim still fine)", () => {
    const { howToCheck: _h, ...noCheck } = full;
    expect(checkCardContract("R-500", "claim", flags, file(noCheck)).ok).toBe(true);
    const r = checkCardContract("R-500", "push", flags, file(noCheck));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("howToCheck");
    expect(cardContractGaps({ ...full, howToCheck: "   " }, "push")).toEqual(["howToCheck"]);
  });

  it("triage needs verdict, why AND at; blank strings count as missing", () => {
    expect(cardContractGaps({ ...full, triage: { verdict: "zaroori" } }, "claim")).toEqual(["triage.why", "triage.at"]);
    expect(cardContractGaps({ ...full, triage: undefined, category: "" }, "claim")).toEqual(["triage.verdict", "triage.why", "triage.at", "category"]);
    expect(cardContractGaps({}, "claim")).toHaveLength(6);
  });

  it("no --card → refused with how-to; --no-card-check only for R-9xx manager cards", () => {
    const none = { cardPath: null, noCheck: false };
    const r = checkCardContract("R-500", "claim", none, file(full));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("--card");
    expect(checkCardContract("R-500", "claim", { cardPath: null, noCheck: true }).ok).toBe(false);
    expect(checkCardContract("R-912", "push", { cardPath: null, noCheck: true }).ok).toBe(true);
    expect(managerCard("R-999")).toBe(true);
    expect(managerCard("R-9001")).toBe(false);
    expect(managerCard("R-842")).toBe(false);
  });

  it("refuses a card file for another card, and unreadable JSON", () => {
    expect(checkCardContract("R-501", "claim", flags, file(full)).message).toContain("R-500");
    expect(checkCardContract("R-500", "claim", flags, () => "{nope").ok).toBe(false);
  });

  it("reads the ArtifactData out_dir file and a {id, data} wrapper alike", () => {
    expect(cardFromJson({ id: "R-500", version: 3, data: full }).kind).toBe("bug");
    expect(checkCardContract("R-500", "claim", flags, file({ id: "R-500", data: full })).ok).toBe(true);
  });

  it("flags come out of the args; areas stay positional", () => {
    expect(parseCardFlags(["C:/wt", "src/lib/deals", "--card", "c.json"])).toEqual({ rest: ["C:/wt", "src/lib/deals"], cardPath: "c.json", noCheck: false });
    expect(parseCardFlags(["--card=c.json", "--no-card-check"])).toEqual({ rest: [], cardPath: "c.json", noCheck: true });
  });
});

/* R-1814 (24 Oct 2026): a worker waiting for its push turn reported "R-1813 push ho gaya: 9e4f6dfc" —
   another worker's card and commit. The success line printed `git rev-parse HEAD` after the rebase, which is
   the OTHER worker's tip when this branch adds nothing (commits already upstream / dropped by the rebase),
   and the wait line put the other card's name where a summary reads it. Now: the push is judged by the
   worker's OWN commits (anutech/manager-pardeep..HEAD), nothing → no push, and every line names its own card. */
describe("push reports its own card and its own commits (R-1814)", () => {
  it("nothing of its own after the rebase → no push, and it says so", () => {
    const r = pushPlan("R-1814", []);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/R-1814/);
    expect(r.message).toMatch(/kuch nahi/);
  });

  it("success line = own card + own newest commit sha, never the upstream tip", () => {
    const r = pushPlan("R-1814", [
      { sha: "aaaa1111", subject: "R-1814: rows open from the keyboard" },
      { sha: "bbbb2222", subject: "R-1814: raw errors" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.sha).toBe("aaaa1111");
    expect(pushDoneLine("R-1814", r)).toBe("✓ R-1814 push ho gaya: aaaa1111 (2 commit apne)");
    expect(pushDoneLine("R-1814", r)).not.toMatch(/R-1813|9e4f6dfc/);
  });

  it("warns when the branch carries commits of another card", () => {
    const r = pushPlan("R-1814", [
      { sha: "aaaa1111", subject: "R-1814: mine" },
      { sha: "cccc3333", subject: "R-1813: someone else's" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.foreign).toEqual(["cccc3333 R-1813: someone else's"]);
  });

  it("the wait line says the other card is someone else's and names mine", () => {
    const line = waitLine("push", "R-1814", "R-1813", "push kar raha hai");
    expect(line).toMatch(/^… R-1814:/);
    expect(line).toMatch(/doosra worker R-1813/);
    expect(line).not.toMatch(/^… R-1813/);
  });
});

/* R-1592 (18 Oct 2026): a <Link href="/wrong-page"> passed the push gate and `npm run typecheck`
   (plain tsc: no .next/types in a fresh worktree / CI checkout → href is just a string) and only
   `next build` went red. Both now run `next typegen` first, like the Cloud Build gate. */
describe("type-check sees typed routes (R-1592)", () => {
  const root = path.resolve(__dirname, "..");
  it("the push gate's tsc step generates route types first", () => {
    expect(TSC_STEPS[0]).toBe("npx next typegen");
    expect(TSC_STEPS[TSC_STEPS.length - 1]).toMatch(/^npx tsc --noEmit/);
  });
  it("npm run typecheck (CI) runs next typegen before tsc", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toMatch(/next typegen && tsc --noEmit/);
  });
  it("tsconfig includes the generated route types and next.config keeps typedRoutes on", () => {
    expect(readFileSync(path.join(root, "tsconfig.json"), "utf8")).toContain(".next/types/**/*.ts");
    expect(readFileSync(path.join(root, "next.config.mjs"), "utf8")).toMatch(/^\s*typedRoutes: true,/m);
  });
});
