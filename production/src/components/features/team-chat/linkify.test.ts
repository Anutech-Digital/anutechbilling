/**
 * R-2299 (G-TEAMCHAT TC-06) — a chat message body is plain text; only http/https links and
 * app-internal paths (/quotes/…) become links. Nothing else can turn into markup or a script.
 */
import { describe, it, expect } from "vitest";
import { linkifyChatText } from "./linkify";

describe("R-2299 linkifyChatText", () => {
  it("plain text stays one text part", () => {
    expect(linkifyChatText("Payment aaya? <b>bold</b>")).toEqual([{ kind: "text", text: "Payment aaya? <b>bold</b>" }]);
  });

  it("an https link becomes an external link, trailing punctuation stays text", () => {
    expect(linkifyChatText("See https://anutech.in/pricing?x=1, then call.")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://anutech.in/pricing?x=1", href: "https://anutech.in/pricing?x=1", external: true },
      { kind: "text", text: ", then call." },
    ]);
  });

  it("an app path becomes an internal link", () => {
    expect(linkifyChatText("Open /quotes/9b1c-22 please")).toEqual([
      { kind: "text", text: "Open " },
      { kind: "link", text: "/quotes/9b1c-22", href: "/quotes/9b1c-22", external: false },
      { kind: "text", text: " please" },
    ]);
  });

  it("javascript:, data:, protocol-relative and backslash paths are never links", () => {
    for (const s of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "//evil.example/x",
      "/\\evil.example",
      "ftp://files.example/a",
      "https://user:pass@evil.example/",
    ]) {
      expect(linkifyChatText(s).every((p) => p.kind === "text"), s).toBe(true);
    }
  });

  it("a path inside a word (a/b, 3/4) is not a link", () => {
    expect(linkifyChatText("GST 18/100 and and/or")).toEqual([{ kind: "text", text: "GST 18/100 and and/or" }]);
  });

  it("joins the parts back to the exact original text", () => {
    const s = "a https://x.example/b. /invoices/1 (http://y.example) end";
    expect(linkifyChatText(s).map((p) => p.text).join("")).toBe(s);
  });
});
