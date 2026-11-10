/**
 * Every customer page that makes the customer WAIT on the server shows what is happening.
 *
 * Owner, 30 Sep 2026: "user gets no feedback at all … not just stuck at a page". Starting
 * a trial took up to 30 s behind a button that said only "Starting your trial…". The fix
 * is <BusyPanel> (components/ui/busy-panel.tsx): what is being done, a running seconds
 * count, and a "taking longer than usual" line.
 *
 * The rule this pins: a file under the public site, checkout and customer pages that POSTs
 * to the server while holding a busy state must render <BusyPanel>, unless it is listed
 * below with the reason its own screen already shows progress.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache

const ROOT = process.cwd();
const AREAS = ["src/app/(marketing)", "src/app/(public)", "src/site"];

const BUSY = /set(Paying|Sending|Submitting|Accepting|Busy|Loading)\(true\)|isSubmitting|setSubmitState\("sending"\)|setState\("busy"\)/;
const POSTS = /method:\s*"POST"/;

const EXEMPT: Record<string, string> = {
  "src/site/components/agent/AgentChat.tsx": "a chat: the reply streams into the conversation, which is its own progress",
  "src/app/(public)/unsubscribe/unsubscribe-client.tsx": "Pardeep's area (OWNERS.json); a one-tap unsubscribe answers in under a second",
  "src/app/(public)/expense-claim/expense-claim-client.tsx": "Pardeep's area (OWNERS.json), staff-only form",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".tsx") && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const files = AREAS.flatMap((a) => walk(join(ROOT, a))).map((f) => ({
  rel: relative(ROOT, f).split(sep).join("/"),
  src: readSource(f),
}));
const waiting = files.filter((f) => BUSY.test(f.src) && POSTS.test(f.src));

describe("customers see progress while the server works (30 Sep 2026)", () => {
  it("guard: the scan found the waiting flows it is meant to check", () => {
    expect(waiting.length).toBeGreaterThanOrEqual(6);
  });

  it("every page that makes the customer wait renders <BusyPanel>", () => {
    const silent = waiting.filter((f) => !EXEMPT[f.rel] && !/<BusyPanel\b/.test(f.src)).map((f) => f.rel);
    expect(silent, "Add <BusyPanel> (components/ui/busy-panel.tsx), or list it in EXEMPT with why").toEqual([]);
  });

  it("no EXEMPT entry is stale", () => {
    const present = new Set(waiting.map((f) => f.rel));
    expect(Object.keys(EXEMPT).filter((k) => !present.has(k))).toEqual([]);
  });

  it("a Razorpay flow hides the panel once Razorpay's own window opens", () => {
    for (const rel of ["src/app/(marketing)/checkout/page.tsx", "src/app/(public)/quote/[id]/accept/quote-accept-view.tsx"]) {
      const src = files.find((f) => f.rel === rel)!.src;
      expect(src, rel).toMatch(/rzp\.open\(\);\s*\n?\s*setPreparing(Payment|Pay)\(false\)/);
    }
  });
});
