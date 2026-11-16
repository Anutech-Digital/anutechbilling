// @vitest-environment jsdom
/**
 * <Collapse> (src/site/motion.css): the website's FAQs open AND close smoothly because the answer
 * stays in the page — but a closed answer must stay out of reach (inert + aria-hidden), exactly as
 * when it was not rendered. And every website FAQ uses it, so none snaps open and shut again.
 */
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Collapse } from "./Collapse";

afterEach(cleanup);

function Faq() {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Question</button>
      <Collapse open={open}><p>Answer with <a href="/x">a link</a></p></Collapse>
    </div>
  );
}

describe("Collapse", () => {
  it("closed: the answer is in the page but inert and hidden from screen readers", () => {
    const { container } = render(<Faq />);
    const outer = container.querySelector(".s-collapse")!;
    const inner = outer.querySelector(".s-collapse-in") as HTMLElement;
    expect(outer.hasAttribute("data-open")).toBe(false);
    expect(inner.hasAttribute("inert")).toBe(true); // jsdom has no .inert property; React writes the attribute
    expect(inner.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("link", { name: "a link" })).toBeNull(); // not in the accessibility tree
  });

  it("open: reachable; closing again keeps the same element (so it can animate shut)", () => {
    const { container } = render(<Faq />);
    const inner = container.querySelector(".s-collapse-in") as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "Question" }));
    expect(container.querySelector(".s-collapse")!.hasAttribute("data-open")).toBe(true);
    expect(inner.hasAttribute("inert")).toBe(false);
    expect(inner.hasAttribute("aria-hidden")).toBe(false);
    expect(screen.getByRole("link", { name: "a link" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Question" }));
    expect(container.querySelector(".s-collapse-in")).toBe(inner);
    expect(inner.hasAttribute("inert")).toBe(true);
  });
});

describe("every website FAQ opens and closes smoothly", () => {
  const root = path.resolve(__dirname, "..", "..", "..", "..");
  const read = (f: string) => readFileSync(path.join(root, f), "utf8");

  it.each([
    "src/site/components/home/HomeCompany.tsx",
    "src/site/components/home/HomeV2.tsx",
    "src/site/components/domains/DomainLanding.tsx",
    "src/site/components/hosting/HostingLanding.tsx",
    "src/app/(public)/buy/workspace/_mobile/sheets.tsx",
    "src/app/(public)/buy/workspace/_parts/info-sections.tsx",
  ])("%s: answers in <Collapse>, never rendered only while open", (file) => {
    const src = read(file);
    expect(src).toMatch(/<Collapse open=\{/);
    expect(src).not.toMatch(/\{\s*(open|isOpen|open === i|openFaq === i)\s*&&\s*<p\b/);
  });

  it.each([
    "src/app/(public)/_components/pricing-sections.tsx",
    "src/site/components/email/WorkspacePricing.tsx",
    "src/site/components/lp/WorkspaceAdLanding.tsx",
    "src/site/components/legal/DataNotice.tsx",
  ])("%s: its <details> carry s-details and load motion.css", (file) => {
    const src = read(file);
    expect(src).toContain('import "@/site/motion.css";');
    const details = [...src.matchAll(/<(?:motion\.)?details\b[^>]*>/g)].map((m) => m[0]);
    expect(details.length).toBeGreaterThan(0);
    // className may sit on a later line of a multi-line tag (pricing-sections): check the file
    expect(src).toMatch(/s-details/);
  });

  it("the pricing FAQ no longer uses the Radix keyframe that needed a variable it never set", () => {
    expect(read("src/app/(public)/_components/pricing-sections.tsx")).not.toContain("animate-accordion-down");
  });
});
