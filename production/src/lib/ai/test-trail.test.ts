/**
 * R-162 — AI Help as a test co-pilot: the trail, the page-scan rules, the duplicate check.
 */
import { describe, it, expect } from "vitest";
import {
  pushTrail, isProblem, classifyToast, apiFailureWorthNoting, apiFailText, trailForPrompt, isInPageUrl,
  badTextFindings, findingsForPrompt, titleOverlap, looksLikeSameBug, TRAIL_MAX, type TrailEvent,
} from "./test-trail";
import { parseHelpAnswer, helpUserTurn, helpSystemPrompt, bugReportText } from "./app-help";

const ev = (kind: TrailEvent["kind"], text: string, at = 1000, path = "/quotes"): TrailEvent => ({ kind, text, at, path });

describe("trail", () => {
  it("keeps the newest TRAIL_MAX events, oldest first", () => {
    let t: TrailEvent[] = [];
    for (let i = 0; i < TRAIL_MAX + 10; i++) t = pushTrail(t, ev("click", `button ${i}`, i * 5000));
    expect(t).toHaveLength(TRAIL_MAX);
    expect(t[0].text).toBe("button 10");
    expect(t.at(-1)!.text).toBe(`button ${TRAIL_MAX + 9}`);
  });
  it("folds a double click on the same control into one line", () => {
    const t = pushTrail(pushTrail([], ev("click", "Save", 1000)), ev("click", "Save", 1800));
    expect(t).toHaveLength(1);
    expect(pushTrail(t, ev("click", "Save", 5000))).toHaveLength(2);
  });
  it("drops empty text", () => {
    expect(pushTrail([], ev("click", "   "))).toHaveLength(0);
  });
  it("marks problems and tells the model their age", () => {
    expect(isProblem(ev("api_fail", "x"))).toBe(true);
    expect(isProblem(ev("click", "x"))).toBe(false);
    const p = trailForPrompt([ev("page", "/quotes", 0), ev("click", 'button "Save"', 10_000), ev("api_fail", "POST /api/quotes → 500", 12_000)], 20_000);
    expect(p).toContain('-10s CLICKED: button "Save" (on /quotes)');
    expect(p).toContain("!! -8s API FAILED: POST /api/quotes → 500");
    expect(p.split("\n")[0]).toBe("-20s OPENED: /quotes");
  });
});

describe("which failed requests count", () => {
  it("records 5xx anywhere and 4xx on our API / Supabase", () => {
    expect(apiFailureWorthNoting("/api/quotes", 500)).toBe(true);
    expect(apiFailureWorthNoting("https://api.anutech.in/rest/v1/quotes?id=eq.1", 403)).toBe(true);
    expect(apiFailureWorthNoting("/api/x", 422)).toBe(true);
  });
  it("ignores success, a signed-out 401, framework chunks and the UX beacon", () => {
    expect(apiFailureWorthNoting("/api/quotes", 200)).toBe(false);
    expect(apiFailureWorthNoting("/api/quotes", 401)).toBe(false);
    expect(apiFailureWorthNoting("/_next/static/chunks/a.js", 404)).toBe(false);
    expect(apiFailureWorthNoting("/api/public/ux/events", 500)).toBe(false);
    expect(apiFailureWorthNoting("https://cdn.example.com/logo.png", 404)).toBe(false);
  });
  /* R-365, 7 Oct 2026: a tester's steps on /quotes/<id> showed "API FAILED: GET
     application/octet-stream;base64,AGFzbQ… → network error" after Download PDF. That was the
     PDF engine's layout wasm (yoga-layout) fetching its own inlined data: URL — nothing is
     sent anywhere, and yoga falls back to decoding the bytes itself, so the PDF was made.
     Recording it sent the tester (and AI Help) after a bug that was not there. */
  it("never records data: or blob: URLs — they never leave the page", () => {
    const wasm = "data:application/octet-stream;base64,AGFzbQEAAAAB";
    expect(isInPageUrl(wasm)).toBe(true);
    expect(isInPageUrl("blob:https://reselleros.anutech.in/6f1c")).toBe(true);
    expect(isInPageUrl("  DATA:text/plain,x")).toBe(true);
    expect(apiFailureWorthNoting(wasm, 500)).toBe(false);
    expect(apiFailureWorthNoting("blob:https://x/1", 404)).toBe(false);
    expect(isInPageUrl("/api/quotes")).toBe(false);
    expect(isInPageUrl("https://api.anutech.in/rest/v1/quotes")).toBe(false);
    /* a URL that merely CONTAINS "data:" is still a real request */
    expect(isInPageUrl("/api/x?data:1")).toBe(false);
  });
  it("keeps the path only — no query string with ids or tokens", () => {
    expect(apiFailText("post", "https://api.anutech.in/rest/v1/quotes?select=*&apikey=SECRET", 500)).toBe("POST /rest/v1/quotes → 500");
    expect(apiFailText("GET", "/api/x", 0)).toBe("GET /api/x → network error");
  });
});

describe("page scan text rules", () => {
  it("catches values that failed to render", () => {
    const f = badTextFindings(["Total ₹NaN", "Due: Invalid Date", "Customer: undefined", "Plan [object Object]", "Hi {{ name }}"]);
    expect(f.map((x) => x.detail.split('"')[1])).toEqual(["NaN", "Invalid Date", "undefined", "[object Object]", "unfilled {{template}}"]);
  });
  it("does not trip on ordinary words that contain them", () => {
    expect(badTextFindings(["Nancy Sharma", "Undefinedly long name? no", "nullable field help", "Annual plan"])).toHaveLength(0);
  });
  it("reports the same problem once", () => {
    expect(badTextFindings(["₹NaN", "₹NaN", "₹NaN"])).toHaveLength(1);
  });
  it("tells the model when nothing was found", () => {
    expect(findingsForPrompt([])).toMatch(/found nothing/);
  });
});

describe("same bug twice?", () => {
  it("matches a reworded title on the same page", () => {
    expect(titleOverlap("Invoice GST shows wrong amount", "GST amount wrong on invoice")).toBeGreaterThanOrEqual(0.6);
    expect(looksLikeSameBug({ title: "GST amount wrong on invoice", pagePath: "/invoices/1" }, { title: "Invoice shows wrong GST amount", page_path: "/invoices/1" })).toBe(true);
  });
  it("does not match a different bug, or the same words on another page", () => {
    expect(looksLikeSameBug({ title: "Save button does nothing on quote", pagePath: "/quotes/new" }, { title: "GST amount wrong on invoice", page_path: "/quotes/new" })).toBe(false);
    expect(looksLikeSameBug({ title: "GST amount wrong", pagePath: "/quotes/new" }, { title: "GST amount wrong", page_path: "/invoices/1" })).toBe(false);
  });
});

describe("AI Help prompt and answer, R-162 additions", () => {
  it("keeps a checklist, capped, and an empty one when absent", () => {
    expect(parseHelpAnswer({ reply: "ok", checklist: ["a", "", "b", ...Array(20).fill("c")] })!.checklist).toHaveLength(8);
    expect(parseHelpAnswer({ reply: "ok" })!.checklist).toEqual([]);
  });
  it("strips markdown the model slipped in", () => {
    expect(parseHelpAnswer({ reply: "## Steps\n1. **'+ New Quote'** dabaiye" })!.reply).toBe("Steps\n1. '+ New Quote' dabaiye");
  });
  it("sends the trail and the scan to the model as separate blocks", () => {
    const turn = helpUserTurn([{ role: "user", text: "Is page ko jaancho." }], { trail: "-3s CLICKED: Save", findings: "- [bad_text] NaN", outline: "Headings: Quotes" });
    expect(turn).toContain("WHAT THE APP RECORDED");
    expect(turn).toContain("AUTOMATIC FINDINGS");
    expect(turn).toContain("PAGE OUTLINE");
    expect(helpUserTurn([{ role: "user", text: "hi" }])).not.toContain("WHAT THE APP RECORDED");
  });
  it("tells the model what each mode asks for", () => {
    expect(helpSystemPrompt({ pagePath: "/x", userName: null, role: null, mode: "scan" })).toMatch(/MODE scan.*checklist/s);
    expect(helpSystemPrompt({ pagePath: "/x", userName: null, role: null, mode: "error" })).toMatch(/do not ask first/);
    expect(helpSystemPrompt({ pagePath: "/x", userName: null, role: null })).toMatch(/MODE chat/);
    // The panel renders plain text: seen on staging 5 Oct, "**+ New Quote**" shown raw.
    expect(helpSystemPrompt({ pagePath: "/x", userName: null, role: null })).toMatch(/no markdown/);
  });
  it("files the app's record with the report", () => {
    const d = parseHelpAnswer({ reply: "r", bugDraft: { title: "Save fails", actual: "500", type: "bug", severity: "high", steps: [] } })!.bugDraft!;
    expect(bugReportText(d, { pagePath: "/q", reporterName: "P", recorded: "!! -1s API FAILED: POST /api/q → 500" })).toContain("What the app recorded (last steps):\n!! -1s API FAILED");
    expect(bugReportText(d, { pagePath: "/q", reporterName: "P" })).not.toContain("What the app recorded");
  });
});

describe("AI Help knows what the page is for (5 Oct 2026)", async () => {
  const { pagePurpose } = await import("./page-purpose");
  it("uses the long note for screens a tooltip cannot explain", () => {
    expect(pagePurpose("/accounting/google-bill-check")).toMatch(/LEAKAGE/);
    expect(pagePurpose("/accounting/google-bill-check")).toMatch(/^Buy › COGS Bills › Google bill check/);
  });
  it("falls back to the nav label and hint, and to the closest parent for detail pages", () => {
    expect(pagePurpose("/accounting/payment-runs")).toMatch(/Payment Runs/);
    expect(pagePurpose("/quotes/Q-123")).toMatch(/Quotes/i);
    expect(pagePurpose(null)).toBeNull();
  });
  it("tells the model to trust it, and has a check_failed mode that drafts without asking", () => {
    const p = helpSystemPrompt({ pagePath: "/x", userName: null, role: null, mode: "check_failed", pagePurpose: "Test purpose" });
    expect(p).toContain("WHAT THIS PAGE IS FOR (trust this over guessing from the URL or the buttons): Test purpose");
    expect(p).toMatch(/MODE check_failed[\s\S]*do not ask first/);
  });
});

/* R-176 (6 Oct 2026): a form asking for a blank field lit AI Help red ("Error caught — Report
   it"). Real failures must still light it; a request to fill something must not. */
describe("classifyToast — fill-this vs real failure", () => {
  it("asking the user to fill or choose something is input, not a bug", () => {
    expect(classifyToast("Choose the new customer's stateThe GST invoice needs it — it decides CGST + SGST or IGST.")).toBe("input_needed");
    expect(classifyToast("State is missingChoose the state — the GST invoice cannot be made without it")).toBe("input_needed");
    expect(classifyToast("Please choose your state. Nothing was charged.")).toBe("input_needed");
    expect(classifyToast("The contact's phone number is required")).toBe("input_needed");
  });
  it("words of failure always win — a real error is never hidden", () => {
    expect(classifyToast("Report not saved: permission denied for table feedback")).toBe("toast_error");
    expect(classifyToast("Add failed — try again")).toBe("toast_error");
    expect(classifyToast("Could not load invoices (500)")).toBe("toast_error");
    expect(classifyToast("Customer is required but the server refused the save")).toBe("toast_error");
  });
  it("unknown wording stays an error (keep the report button when unsure)", () => {
    expect(classifyToast("Something odd happened")).toBe("toast_error");
  });
  it("a toast the app marked as needs-input is input whatever it says", () => {
    expect(classifyToast("Anything at all", true)).toBe("input_needed");
  });
  it("input_needed is not a problem — AI Help does not turn red for it", () => {
    expect(isProblem({ kind: "input_needed", at: 0, text: "x", path: "/" })).toBe(false);
    expect(isProblem({ kind: "toast_error", at: 0, text: "x", path: "/" })).toBe(true);
  });
});
