// R-315 (7 Oct 2026): at 375px the quote builder's sticky bottom bar stacked Save draft,
// Preview, Send via email, Send via WhatsApp and Save & send one under another — 253px,
// a third of the screen. Below md it must be ONE row: total + the main button + a "More"
// menu that still reaches every other action (same handlers). jsdom has no layout engine,
// so this guards the classes and wiring that produce that; the visual check is done in the
// browser at 375px by the manager.
// R-1726 (21 Oct 2026): five buttons became three — Save draft · Preview · ONE "Send ▾" whose
// menu holds email / WhatsApp / mark sent. Ctrl+Enter still runs the usual send.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(process.cwd(), "src/components/features/quotes/quote-builder.tsx"),
  "utf8",
);

function bar(): { root: string; body: string } {
  const at = src.indexOf("data-quote-action-bar");
  expect(at, "sticky action bar not found").toBeGreaterThan(-1);
  const root = src.slice(at, src.indexOf(">", at) + 1);
  // The bar ends at the Support plan card that follows it.
  const end = src.indexOf("Support plan — sold with the licences", at);
  return { root, body: src.slice(at, end) };
}

/** The quote-mode part of the bar (after the invoice-mode "Create invoice" button). */
function quoteBar(): string {
  const { body } = bar();
  return body.slice(body.indexOf(">Create invoice</span>"));
}

/** The opening tag of the JSX element whose text content contains `label`. */
function tagBefore(body: string, label: string): string {
  const i = body.indexOf(label);
  expect(i, `${label} not found`).toBeGreaterThan(-1);
  const open = Math.max(body.lastIndexOf("<Button", i), body.lastIndexOf("<DropdownMenuItem", i));
  return body.slice(open, i);
}

describe("quote builder sticky bar on a phone (R-315)", () => {
  it("is one row below md (no wrap) and only wraps from md up", () => {
    const { root } = bar();
    expect(root).toMatch(/\bflex-nowrap\b/);
    expect(root).toMatch(/\bmd:flex-wrap\b/);
    expect(root).not.toMatch(/(^|\s)flex-wrap\b/);
  });

  it("hides Save draft and Preview buttons below md (they are in the phone More menu)", () => {
    const body = quoteBar();
    for (const label of ["Save draft", "Preview"]) {
      const firstButton = tagBefore(body, label);
      expect(firstButton, label).toMatch(/^<Button/);
      expect(firstButton, label).toMatch(/hidden md:inline-flex/);
    }
    const menu = body.slice(body.indexOf('aria-label="More actions"'), body.indexOf("</DropdownMenuContent>"));
    expect(menu).toMatch(/onSelect=\{\(\) => handleSubmit\("draft"\)\}[^]*Save draft/);
    expect(menu).toMatch(/onSelect=\{openPreview\}[^]*Preview/);
  });
});

describe("one Send button (R-1726)", () => {
  const body = quoteBar();
  const send = body.slice(body.indexOf("data-send-menu") - 200);

  it("the quote bar has exactly one primary button, and it opens the Send menu", () => {
    expect(body.match(/variant="primary"/g)?.length).toBe(1);
    expect(send).toMatch(/<DropdownMenuTrigger asChild>\s*<Button\s+variant="primary"\s+icon="send"/);
    expect(body).not.toMatch(/>\s*Send via email\s*<\/Button>/);
    expect(body).not.toMatch(/>\s*Send via WhatsApp\s*<\/Button>/);
  });

  it("menu: email / WhatsApp / mark sent, each gated like the old buttons", () => {
    const menu = send.slice(send.indexOf("<DropdownMenuContent"), send.indexOf("</DropdownMenuContent>"));
    expect(menu).toMatch(/handleSubmit\("sent", sendPlan === "mark-sent" \? "email" : "send-now"\)[^]*Send via email/);
    expect(menu).toMatch(/handleSubmit\("sent", "whatsapp"\)[^]*Send via WhatsApp/);
    expect(menu).toMatch(/handleSubmit\("sent", sendPlan === "mark-sent" \? "send-now" : "mark-sent"\)[^]*Save &amp; mark sent/);
    expect(menu.match(/disabled=\{sendDisabled\}/g)?.length).toBe(3);
    expect(src).toMatch(/const sendDisabled = !isLeadMode && !customerId && !prospectName\.trim\(\);/);
  });

  it("Ctrl+Enter still sends (same handler as before)", () => {
    expect(src).toMatch(/\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === "Enter"[^]*handleSubmitRef\.current\("sent", "send-now"\)/);
  });

  it("an explicit mark-sent never emails and never opens a send dialog", () => {
    expect(src).toMatch(/afterAction === "mark-sent" \? \(sendPlan === "needs-approval" \? "needs-approval" : "mark-sent"\)/);
    expect(src).toMatch(/const suffix = afterAction === "email" \|\| afterAction === "whatsapp" \?/);
  });

  it("invoice mode keeps Preview reachable on a phone via the menu", () => {
    const { body: all } = bar();
    const invoice = all.slice(0, all.indexOf(">Create invoice</span>"));
    expect(invoice).toMatch(/<Button icon="file" className="hidden md:inline-flex" onClick=\{openPreview\}>/);
    expect(invoice).toMatch(/<DropdownMenuItem[^>]*onSelect=\{openPreview\}/);
  });
});

describe("prospect help text says the truth (R-1726, R-1706)", () => {
  it("the customer record is created when they accept — not only when they pay", () => {
    expect(src).toMatch(/customer record is created when they accept/);
    expect(src).not.toMatch(/auto-create the customer record when they pay/);
    expect(src).not.toMatch(/created\s+automatically once payment is received/);
  });
});
