/**
 * AI Help (R-158): what counts as a usable answer, and what an AI-filed report says.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHelpAnswer, parseHelpActions, parseFollowUps, FOLLOW_UP_MAX_CHARS, askAboutSelection, buildTestRunPrompt, bugReportText, helpUserTurn, helpSystemPrompt, AI_FILED_TAG, HELP_MAX_MESSAGES } from "./app-help";
import { testHistoryForPrompt } from "./page-test-runs";

const draft = { title: "Invoice PDF shows IGST for a Delhi customer", type: "bug", severity: "critical", actual: "IGST 18% on a Delhi-to-Delhi invoice", expected: "CGST 9% + SGST 9%", steps: ["Open Invoices", "Open INV-1", "Download PDF"], chatSummary: "Asked why tax looked wrong; same state as ours." };

describe("parseHelpAnswer", () => {
  it("keeps a complete draft", () => {
    const a = parseHelpAnswer({ reply: "Draft taiyaar hai", bugDraft: draft });
    expect(a?.bugDraft?.title).toBe(draft.title);
    expect(a?.bugDraft?.severity).toBe("critical");
    expect(a?.bugDraft?.steps).toHaveLength(3);
  });
  it("a half draft (no title or no actual result) is dropped, never filed", () => {
    expect(parseHelpAnswer({ reply: "ok", bugDraft: { ...draft, title: "" } })?.bugDraft).toBeNull();
    expect(parseHelpAnswer({ reply: "ok", bugDraft: { ...draft, actual: "  " } })?.bugDraft).toBeNull();
  });
  it("unknown type / severity fall back to bug / medium", () => {
    const a = parseHelpAnswer({ reply: "ok", bugDraft: { ...draft, type: "crash", severity: "urgent" } });
    expect(a?.bugDraft?.type).toBe("bug");
    expect(a?.bugDraft?.severity).toBe("medium");
  });
  it("no reply → no answer (the route shows its 'unavailable' line)", () => {
    expect(parseHelpAnswer({ bugDraft: draft })).toBeNull();
    expect(parseHelpAnswer(null)).toBeNull();
    expect(parseHelpAnswer("text")).toBeNull();
  });
  it("caps lengths so a runaway answer cannot flood the report", () => {
    const a = parseHelpAnswer({ reply: "x".repeat(5000), bugDraft: { ...draft, title: "t".repeat(500), steps: Array(40).fill("s") } });
    expect(a!.reply.length).toBe(2000);
    expect(a!.bugDraft!.title.length).toBe(160);
    expect(a!.bugDraft!.steps.length).toBe(12);
  });
});

describe("bugReportText — the row the feedback table gets", () => {
  const t = bugReportText(parseHelpAnswer({ reply: "r", bugDraft: draft })!.bugDraft!, { pagePath: "/invoices/INV-1", reporterName: "Pardeep Sharma" });
  it("first line is the title (how the admin list reads rows)", () => {
    expect(t.split("\n")[0]).toBe(draft.title);
  });
  it("carries page, what happened, expected and numbered steps", () => {
    expect(t).toContain("Page: /invoices/INV-1");
    expect(t).toContain("What happened:\nIGST 18%");
    expect(t).toContain("What should happen:\nCGST 9%");
    expect(t).toContain("1. Open Invoices\n2. Open INV-1\n3. Download PDF");
  });
  it("ends with the short AI tag and whose report it is", () => {
    expect(t.trim().split("\n").pop()).toBe(`${AI_FILED_TAG} with Pardeep Sharma.`);
  });
});

describe("prompt", () => {
  it("only the last HELP_MAX_MESSAGES turns go to the model", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, text: `m${i}` }));
    const turn = helpUserTurn(many);
    expect(turn).not.toContain("m0\n");
    expect(turn.split("PERSON:").length - 1).toBe(HELP_MAX_MESSAGES);
  });
  it("the model is told it does not file anything itself", () => {
    expect(helpSystemPrompt({ pagePath: "/x", userName: null, role: null })).toMatch(/Do not say the report is filed/);
  });
});

describe("wiring", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "../..", rel), "utf8");
  it("the panel files only from the button, as ai-chat, under the signed-in user", () => {
    const ui = read("components/shared/ai-help.tsx");
    expect(ui).toMatch(/filedVia: "ai-chat"/);
    expect(ui).toMatch(/reporterId: currentUser\?\.userId/);
    expect(ui).toMatch(/onClick=\{\(\) => file\(i\)\}/);
  });
  it("every app page mounts it", () => {
    expect(read("app/(app)/layout.tsx")).toMatch(/<AiHelp \/>/);
  });
});

/* R-189: the fixes AI Help may offer. A closed list; the model cannot widen it. */

describe("parseHelpActions — only safe, checkable fixes survive", () => {
  const C = "889694f9-597c-4181-96ff-6f4b878bce4e";
  const allowed = new Set([C]);

  it("keeps an in-app link and a state fix for a listed customer", () => {
    expect(parseHelpActions([
      { kind: "open", label: "Edit", href: `/customers/${C}/edit` },
      { kind: "set_customer_state", label: "Set Delhi", customerId: C, stateCode: "07" },
      { kind: "set_company_state", label: "Company Delhi", stateCode: "07" },
    ], allowed)).toHaveLength(3);
  });

  it("drops links that leave the app", () => {
    for (const href of ["https://evil.example", "//evil.example/x", "javascript:alert(1)", "\\evil", "customers"]) {
      expect(parseHelpActions([{ kind: "open", label: "x", href }], allowed)).toEqual([]);
    }
  });

  it("drops a state fix for a customer the server did not list, or a made-up state code", () => {
    expect(parseHelpActions([{ kind: "set_customer_state", label: "x", customerId: "00000000-0000-4000-8000-000000000000", stateCode: "07" }], allowed)).toEqual([]);
    expect(parseHelpActions([{ kind: "set_customer_state", label: "x", customerId: C, stateCode: "99" }], allowed)).toEqual([]);
    expect(parseHelpActions([{ kind: "set_company_state", label: "x", stateCode: "7" }], allowed)).toEqual([]);
  });

  it("drops any kind it does not know (money, email, delete) and caps at three", () => {
    expect(parseHelpActions([{ kind: "record_payment", label: "Pay", amount: 5000 }, { kind: "delete_invoice", label: "Del" }], allowed)).toEqual([]);
    const many = Array.from({ length: 6 }, (_, i) => ({ kind: "open", label: `p${i}`, href: "/invoices" }));
    expect(parseHelpActions(many, allowed)).toHaveLength(3);
  });

  it("parseHelpAnswer carries actions through", () => {
    const a = parseHelpAnswer({ reply: "ok", checklist: [], actions: [{ kind: "open", label: "Settings", href: "/settings?tab=company" }], bugDraft: null });
    expect(a?.actions).toEqual([{ kind: "open", label: "Settings", href: "/settings?tab=company" }]);
  });
});

/* R-195: what a text selection becomes in AI Help's box. */
describe("askAboutSelection", () => {
  it("turns a selection into a question, whitespace collapsed", () => {
    expect(askAboutSelection("  ₹19.3K\n  1 invoice owed ")).toBe('"₹19.3K 1 invoice owed" — ye kya hai, aur ispar dhyan dene wali koi baat?');
  });
  it("offers nothing for empty, one character, or a whole page dragged over", () => {
    expect(askAboutSelection("")).toBeNull();
    expect(askAboutSelection(null)).toBeNull();
    expect(askAboutSelection("x")).toBeNull();
    expect(askAboutSelection("a".repeat(601))).toBeNull();
  });
  it("caps a long selection at 300 characters", () => {
    const q = askAboutSelection("b".repeat(450))!;
    expect(q).toContain("b".repeat(300) + "…");
    expect(q).not.toContain("b".repeat(301));
  });
});

/* R-196: the "Run these tests in browser" prompt. */
describe("buildTestRunPrompt", () => {
  const p = buildTestRunPrompt({ pagePath: "/deals", tests: ["Add lead with  ₹0 value", "", "Switch to Kanban view"] });
  it("lists the tests, numbered, blanks dropped and spaces collapsed", () => {
    expect(p).toContain("Page: /deals");
    expect(p).toContain("1. Add lead with ₹0 value");
    expect(p).toContain("2. Switch to Kanban view");
    expect(p).not.toContain("3.");
  });
  it("keeps the safety rules: local app only, real repo, board, archive only its own session", () => {
    expect(p).toContain("http://localhost:3001");
    expect(p).toMatch(/Live\/staging par form submit ya kuch save MAT karo/);
    expect(p).toContain("Anutech-Digital/anutechbilling");
    expect(p).toContain(String.raw`C:\Users\mso50\new-reselleros`);
    expect(p).toMatch(/SIRF agar ye session ISI prompt se shuru hua/);
  });
  it("caps at 12 tests", () => {
    const many = buildTestRunPrompt({ pagePath: "/x", tests: Array.from({ length: 20 }, (_, i) => `t${i}`) });
    expect(many).toContain("12. t11");
    expect(many).not.toContain("13. t12");
  });
});

/* 6 Oct: a pasted test prompt ran in a CLOUD session, which cannot reach localhost. */
describe("buildTestRunPrompt — cloud check", () => {
  it("tells a cloud session to stop and ask for a Local session", () => {
    const p = buildTestRunPrompt({ pagePath: "/deals", tests: ["x"] });
    expect(p).toContain("CLOUD CHECK");
    expect(p).toMatch(/naya session LOCAL chun kar chalaiye/);
  });
});

describe("R-352: test results come back into the app", () => {
  const T = "93b38539-0a9b-4942-bb33-3daa6cff97df";
  it("the test-run prompt posts the result to the agent endpoint on the local app, token never printed", () => {
    const p = buildTestRunPrompt({ pagePath: "/deals?tab=kanban", tests: ["x"], tenantId: T });
    expect(p).toContain("http://localhost:3001/api/agent/page-test-runs");
    expect(p).toContain(`"tenantId":"${T}"`);
    expect(p).toContain(`"page":"/deals"`);
    expect(p).toContain("rev-parse --short HEAD");
    expect(p).toContain("Authorization: Bearer $(grep '^AGENT_QUEUE_TOKEN=' production/.env.local");
    expect(p).toMatch(/Token KABHI print/);
    // after the board step, not instead of it
    expect(p.indexOf("NATEEJA BOARD PAR")).toBeLessThan(p.indexOf("NATEEJA APP ME"));
  });
  it("a missing or odd tenant id becomes a placeholder, not injected text", () => {
    expect(buildTestRunPrompt({ pagePath: "/deals", tests: ["x"] })).toContain("<tenant uuid");
    expect(buildTestRunPrompt({ pagePath: "/deals", tests: ["x"], tenantId: "\"; rm -rf" })).not.toContain("rm -rf");
  });
  it("the system prompt carries the previous results and the no-repeat rule only when there is a run", () => {
    const history = testHistoryForPrompt({
      pagePath: "/deals", runAt: "2026-10-07T05:22:00Z", buildSha: "51629ab", runBy: "AI browser test",
      results: [{ test: "Add a deal with ₹0 value", result: "pass" }, { test: "Back button keeps the filter", result: "fail" }],
    }, "51629ab");
    const withRun = helpSystemPrompt({ pagePath: "/deals", userName: null, role: "owner", mode: "scan", testHistory: history });
    expect(withRun).toContain("PREVIOUS TESTS on this page");
    expect(withRun).toContain("✓ passed: Add a deal with ₹0 value");
    expect(withRun).toContain("✗ failed: Back button keeps the filter");
    expect(withRun).toMatch(/do NOT suggest any ✓ passed test again/);
    const without = helpSystemPrompt({ pagePath: "/deals", userName: null, role: "owner", mode: "scan", testHistory: null });
    expect(without).not.toContain("PREVIOUS TESTS");
    expect(without).toBe(helpSystemPrompt({ pagePath: "/deals", userName: null, role: "owner", mode: "scan" }));
  });
});

describe("followUps (R-353)", () => {
  it("keeps 0–3 clean questions from the same answer", () => {
    expect(parseHelpAnswer({ reply: "ok" })?.followUps).toEqual([]);
    expect(parseHelpAnswer({ reply: "ok", followUps: [] })?.followUps).toEqual([]);
    expect(parseHelpAnswer({ reply: "ok", followUps: ["Quick Add bar pehle"] })?.followUps).toEqual(["Quick Add bar pehle"]);
    expect(parseHelpAnswer({ reply: "ok", followUps: ["a?", "b?", "c?", "d?", "e?"] })?.followUps).toEqual(["a?", "b?", "c?"]);
  });
  it("also comes with a bug draft", () => {
    expect(parseHelpAnswer({ reply: "Draft", bugDraft: draft, followUps: ["Aur kya check karun?"] })?.followUps).toEqual(["Aur kya check karun?"]);
  });
  it("cuts a long one at a word with …, never over the limit", () => {
    const long = "Is page par overdue tasks ko ek saath agle hafte kaise shift karun bina har ek khole aur bina galti ke";
    const [f] = parseFollowUps([long]);
    expect(f.length).toBeLessThanOrEqual(FOLLOW_UP_MAX_CHARS);
    expect(f.endsWith("…")).toBe(true);
    expect(long.startsWith(f.slice(0, -1))).toBe(true);
    expect(f.slice(0, -1).endsWith(" ")).toBe(false);
  });
  it("ignores wrong types, blanks, markdown and duplicates", () => {
    expect(parseFollowUps("Quick Add pehle")).toEqual([]);
    expect(parseFollowUps(null)).toEqual([]);
    expect(parseFollowUps([1, null, { q: "x" }, "  ", "**Bulk  reschedule** pehle", "bulk reschedule pehle", "Quick Add pehle"]))
      .toEqual(["Bulk reschedule pehle", "Quick Add pehle"]);
  });
  it("the prompt asks for them in the person's language and as options when the reply asks to choose", () => {
    const p = helpSystemPrompt({ pagePath: "/tasks", userName: null, role: "owner" });
    expect(p).toContain('"followUps": string[]');
    expect(p).toMatch(/Hinglish reply means Hinglish followUps/);
    expect(p).toMatch(/followUps ARE those options/);
  });
});
