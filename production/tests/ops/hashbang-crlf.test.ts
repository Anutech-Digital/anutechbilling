import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { commentOutHashbang, hashbangCrlfPlugin } from "../../src/test/hashbang-crlf";

/* R-2553: `#!` ops scripts with Windows (CRLF) line endings failed at import under Vitest
   ("SyntaxError: Invalid or unexpected token") — Vite's hashbang regex stops at \r and the hoisted
   imports landed above `#!`. vitest.config.ts runs hashbangCrlfPlugin() to fix it. */

describe("hashbang + CRLF under Vitest (R-2553)", () => {
  it("comments out only a first-line hashbang, keeping the line count", () => {
    const src = "#!/usr/bin/env node\r\nimport fs from \"node:fs\";\r\nexport const a = 1;\r\n";
    const out = commentOutHashbang(src);
    expect(out.startsWith("//#!/usr/bin/env node\r\n")).toBe(true);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(commentOutHashbang("const x = '#!';\n")).toBe("const x = '#!';\n");
    expect(commentOutHashbang("// #! not first\n")).toBe("// #! not first\n");
  });

  it("the plugin runs before Vite's own transform and leaves other files alone", () => {
    const p = hashbangCrlfPlugin();
    expect(p.enforce).toBe("pre");
    expect(p.transform("export const a = 1;\n")).toBeNull();
    expect(p.transform("#!/usr/bin/env node\r\nexport const a = 1;\r\n")?.code).toBe("//#!/usr/bin/env node\r\nexport const a = 1;\r\n");
  });

  it("a CRLF `#!` module with imports really loads (the way staging-smoke.mjs failed)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "r2553-hashbang-"));
    const file = path.join(dir, "crlf-script.mjs");
    writeFileSync(file, [
      "#!/usr/bin/env node",
      "/**",
      " * a script with a hashbang, CRLF endings and a static import",
      " */",
      'import path from "node:path";',
      'export const joined = path.join("a", "b");',
      "",
    ].join("\r\n"));
    try {
      const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { joined: string };
      expect(mod.joined).toBe(path.join("a", "b"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
