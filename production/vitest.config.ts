import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest = unit tests only (pure logic under src/). Playwright E2E specs live in
// e2e/ and run via `npm run test:e2e` — they MUST be excluded here, otherwise
// `vitest run` tries to execute Playwright's test.describe() and fails.
export default defineConfig({
  // Mirror the tsconfig `@/*` → `src/*` alias so tests can import modules that
  // use the `@` alias at runtime (not just as type-only imports).
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      /* `server-only` ka `exports` sirf `react-server` condition ke saath khulta hai, jo
         Vitest ke paas nahi hai — us package ko import karte hi suite load hone se pehle
         gir jaati hai. Wo package runtime par kuch karta bhi nahi; uska kaam build par hai.
         Dekho src/test/server-only-stub.ts. */
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  // Next.js compiles JSX with the automatic runtime, so components don't import
  // React. Vitest's esbuild defaults to the classic runtime, which made any
  // component test fail with "React is not defined" inside shared UI (icon.tsx,
  // card.tsx…). Matching Next here keeps the app code untouched.
  esbuild: { jsx: "automatic" },
  test: {
    // next-auth imports "next/server" without an extension; let Vite resolve it (5 Oct 2026).
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
    // src/ is the app. tests/ is for repo assets that are not part of the app and have no
    // build step -- currently dashboard.html, whose logic lives in an inline <script> and
    // can only be reached by extracting it. Keeping those under src/ would imply the app
    // ships them.
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    // tests/isolation needs a real Postgres (npm run db:local) — run it with npm run test:isolation.
    exclude: ["node_modules", "e2e", ".next", "dist", "playwright-report", "test-results", "tests/isolation/**"],
  },
});
