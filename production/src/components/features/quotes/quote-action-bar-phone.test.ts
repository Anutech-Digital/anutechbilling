// R-315 (7 Oct 2026): at 375px the quote builder's sticky bottom bar stacked Save draft,
// Preview, Send via email, Send via WhatsApp and Save & send one under another — 253px,
// a third of the screen. Below md it must be ONE row: total + the main button + a "More"
// menu that still reaches every other action (same handlers). jsdom has no layout engine,
// so this guards the classes and wiring that produce that; the visual check is done in the
// browser at 375px by the manager.
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

  it("hides the secondary buttons below md", () => {
    const { body } = bar();
    for (const label of ["Save draft", "Send via email", "Send via WhatsApp"]) {
      const firstButton = tagBefore(body, label);
      expect(firstButton, label).toMatch(/^<Button/);
      expect(firstButton, label).toMatch(/hidden md:inline-flex/);
    }
  });

  it("keeps Save & send visible on a phone with a short label", () => {
    const { body } = bar();
    // R-408: the label comes from saveAndSendLabel() ("Save & send" / "Mark sent" short).
    expect(body).toMatch(/<span className="md:hidden">\{sendLabel\.short\}<\/span>/);
    expect(body).toMatch(/<span className="hidden md:inline">\{sendLabel\.full\}<\/span>/);
  });

  it("puts every other action in a phone-only More menu with the same handlers", () => {
    const { body } = bar();
    expect(body).toMatch(/aria-label="More actions"\s+className="md:hidden/);
    const menu = body.slice(body.lastIndexOf("<DropdownMenuContent"), body.lastIndexOf("</DropdownMenuContent>"));
    expect(menu).toMatch(/onSelect=\{\(\) => handleSubmit\("draft"\)\}[^]*Save draft/);
    expect(menu).toMatch(/onSelect=\{openPreview\}[^]*Preview/);
    expect(menu).toMatch(/onSelect=\{\(\) => handleSubmit\("sent", "email"\)\}[^]*Send via email/);
    expect(menu).toMatch(/onSelect=\{\(\) => handleSubmit\("sent", "whatsapp"\)\}[^]*Send via WhatsApp/);
  });

  it("menu send items are disabled by the same rule as the buttons", () => {
    const { body } = bar();
    const menu = body.slice(body.lastIndexOf("<DropdownMenuContent"), body.lastIndexOf("</DropdownMenuContent>"));
    expect(menu.match(/disabled=\{sendDisabled\}/g)?.length).toBe(2);
    expect(src).toMatch(/const sendDisabled = !isLeadMode && !customerId && !prospectName\.trim\(\);/);
  });

  it("invoice mode keeps Preview reachable on a phone via the menu", () => {
    const { body } = bar();
    const invoice = body.slice(0, body.indexOf(">Create invoice</span>"));
    expect(invoice).toMatch(/<Button icon="file" className="hidden md:inline-flex" onClick=\{openPreview\}>/);
    expect(invoice).toMatch(/<DropdownMenuItem[^>]*onSelect=\{openPreview\}/);
  });
});
