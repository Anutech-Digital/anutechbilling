// @vitest-environment jsdom
/**
 * R-1533 / R-1534 / R-1535 — a failed load on a sales screen says what happened in plain
 * words and offers Try again; it never prints raw database text (CLAUDE.md §11, §24).
 *
 *  1. The shared <LoadError> turns any thrown value into a sentence for a human.
 *  2. Source scan: the sales screens' error boxes do not paste `error.message` on screen.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { LoadError, LoadErrorInline, loadErrorBody } from "@/components/shared/load-error";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const RAW = [
  'permission denied for table leads',
  'relation "public.leads" does not exist',
  "Could not find the function public.today_inbox without parameters in the schema cache",
  "TypeError: Cannot read properties of undefined (reading 'map')",
  'column leads.foo does not exist',
];

describe("loadErrorBody — plain words for a failed READ", () => {
  it.each(RAW)("never echoes %s", (msg) => {
    const body = loadErrorBody({ message: msg, code: "42501" });
    expect(body).not.toContain(msg);
    expect(body).not.toMatch(/relation|schema cache|TypeError|column|permission denied for table/);
    expect(body.length).toBeGreaterThan(20);
  });
  it("says network problem for a failed fetch, and does not claim 'Nothing was saved'", () => {
    const body = loadErrorBody(new Error("TypeError: Failed to fetch"));
    expect(body).toMatch(/Network problem/);
    expect(body).not.toMatch(/Nothing was saved/);
  });
  it("says who to ask when access is refused", () => {
    expect(loadErrorBody({ message: "new row violates row-level security policy" })).toMatch(/Ask the owner/);
  });
  it("has a safe default with no error", () => {
    expect(loadErrorBody(null)).toMatch(/data is safe/);
  });
});

describe("<LoadError> / <LoadErrorInline>", () => {
  it("shows what failed, plain words, Try again — not the raw text", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();
    render(<LoadError what="Leads" error={{ message: RAW[0] }} onRetry={retry} />);
    expect(screen.getByText("Leads didn't load")).toBeTruthy();
    expect(screen.queryByText(new RegExp(RAW[0]))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it("inline variant is an alert with Try again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();
    render(<LoadErrorInline what="This chat" error={{ message: RAW[1] }} onRetry={retry} />);
    expect(screen.getByRole("alert").textContent).toMatch(/This chat didn.t load/);
    expect(screen.getByRole("alert").textContent).not.toContain(RAW[1]);
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

/* The raw text used to be pasted straight into the error box. */
const SCREENS = [
  "src/components/features/leads/leads-empty-states.tsx", // /leads and /deals
  "src/app/(app)/contacts/page.tsx",
  "src/app/(app)/today/page.tsx",
  "src/app/(app)/whatsapp/page.tsx",
  "src/app/(app)/team/page.tsx",
];

const code = (f: string) => readFileSync(join(process.cwd(), f), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("sales screens do not put raw error text on screen", () => {
  it.each(SCREENS)("%s", (f) => {
    const src = code(f);
    expect(src).not.toMatch(/body=\{\s*\(?\s*error\s*(as\s+Error\s*\)?)?\s*\.message\s*\}/);
    expect(src).not.toMatch(/\{\s*\(?\s*\w+\.error\s*(as\s+Error\s*\)?)?\s*\??\.message\s*\}/);
    expect(src).not.toMatch(/\{\s*\(\s*error\s+as\s+Error\s*\)\.message\s*\}/);
    expect(src).not.toMatch(/has not been applied/);
  });
});
