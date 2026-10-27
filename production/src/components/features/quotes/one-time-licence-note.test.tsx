// @vitest-environment jsdom
/* R-1963 — a saved draft with a licence line on One-time says so next to its Commit select. */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OneTimeLicenceNote } from "./one-time-licence-note";

afterEach(cleanup);

describe("R-1963 one-time licence note", () => {
  it("warns on a licence line saved without a term", () => {
    render(<OneTimeLicenceNote line={{ name: "Google Workspace Business Starter (1 year)", commitment: undefined }} />);
    expect(screen.getByRole("note").textContent).toMatch(/no subscription or renewal/);
  });
  it("is silent once a term is picked, and on a plain one-time service", () => {
    render(<OneTimeLicenceNote line={{ name: "GW Business Starter (1 year)", commitment: "annual_yearly" }} />);
    render(<OneTimeLicenceNote line={{ name: "Data migration", commitment: undefined }} />);
    expect(screen.queryByRole("note")).toBeNull();
  });
  it("the builder shows it beside both Commit selects (desktop row and phone card)", () => {
    const src = readFileSync(join(__dirname, "quote-builder.tsx"), "utf8");
    expect(src.match(/<OneTimeLicenceNote line=\{line\}/g)?.length ?? 0).toBe(2);
  });
});
