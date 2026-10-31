import type { Config } from "tailwindcss";
// An import, not require(): on Node 24 Tailwind first loads this .ts file as an ES module,
// where require() does not exist, and the ReferenceError took the whole dev server down
// (29 Sep 2026). An import works on every Node and in the build.
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts,jsx,tsx}",
    /* The vendored marketing site (merge brick #5). Most of it is styled by its
       own scoped stylesheet, but the ported hosting landing is pure Tailwind —
       without this glob its violet/gradient classes are never generated and the
       page renders unstyled. */
    "./src/site/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1280px",
      },
    },
    extend: {
      /**
       * The two rungs Tailwind's scale is missing.
       *
       * ─── WHY THERE WAS NO fontSize KEY HERE AT ALL ──────────────────────────
       * Tailwind stops at `text-xs` = 12px. This app's densest surfaces live below that, so
       * 2,010 elements reached for `text-[Npx]` instead — 1,143 at 11px and 820 at 10px, across
       * 274 files. That is not 274 authors being careless; it is one missing scale, measured and
       * written up in docs/TYPE-SCALE-PROPOSAL.md.
       *
       * ─── FONT-SIZE ONLY, AND THAT IS DELIBERATE ─────────────────────────────
       * `text-xs` sets font-size AND line-height. These two set font-size alone, exactly as
       * `text-[11px]` did — so renaming 1,963 call sites to them changes nothing that renders.
       * Measured in the browser first: with no line-height of its own, 11px text inherits the
       * root's unitless 1.5 and computes to 16.5px. Had these rungs carried `lineHeight: 1rem`
       * the way a normal Tailwind scale does, every one of those 1,963 elements would have
       * shifted its leading — 0.5px each, in 274 files, in the same commit as a mechanical
       * rename. Leading is a separate, visible decision; it gets its own commit and its own
       * before/after measurement.
       */
      fontSize: {
        /* R-087 / R-134 (3 Oct 2026): both rungs raised to 12px. At 10–11px labels, dates and
           badges could not be read on a phone, and the UI agent counted 55 such texts on the
           Dashboard alone. 12px is the floor; the names stay so no call site changes. */
        "3xs": "0.75rem", // 12px (was 10px)
        "2xs": "0.75rem", // 12px (was 11px)
      },
      fontFamily: {
        serif: ["var(--font-serif)", "DM Serif Display", "Georgia", "serif"],
        sans: ["var(--font-sans)", "Plus Jakarta Sans", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "monospace"],
      },
      colors: {
        // Semantic tokens drive everything (port from prototype/styles.css)
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        paper: {
          DEFAULT: "hsl(var(--paper) / <alpha-value>)",
          2: "hsl(var(--paper-2) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "hsl(var(--ink) / <alpha-value>)",
          2: "hsl(var(--ink-2) / <alpha-value>)",
          3: "hsl(var(--ink-3) / <alpha-value>)",
          4: "hsl(var(--ink-4) / <alpha-value>)",
        },
        hairline: {
          DEFAULT: "hsl(var(--hairline) / <alpha-value>)",
          strong: "hsl(var(--hairline-strong) / <alpha-value>)",
        },
        // Brand accent (amber/orange — Google authorized partner vibe)
        amber: {
          DEFAULT: "hsl(var(--amber) / <alpha-value>)",
          soft: "hsl(var(--amber-soft) / <alpha-value>)",
          ink: "hsl(var(--amber-ink) / <alpha-value>)",
        },
        // Status colors
        /* `ink` is the readable text colour on the matching `soft` fill. Amber and indigo had
           one; these two did not — while `text-rose-ink` (10 uses) and `text-emerald-ink`
           (8 uses) were already written in the app and rendering nothing at all, because
           Tailwind emits no rule for a colour the config never declares. */
        emerald: {
          DEFAULT: "hsl(var(--emerald) / <alpha-value>)",
          soft: "hsl(var(--emerald-soft) / <alpha-value>)",
          ink: "hsl(var(--emerald-ink) / <alpha-value>)",
        },
        rose: {
          DEFAULT: "hsl(var(--rose) / <alpha-value>)",
          soft: "hsl(var(--rose-soft) / <alpha-value>)",
          ink: "hsl(var(--rose-ink) / <alpha-value>)",
        },
        indigo: {
          DEFAULT: "hsl(var(--indigo) / <alpha-value>)",
          soft: "hsl(var(--indigo-soft) / <alpha-value>)",
          ink: "hsl(var(--indigo-ink) / <alpha-value>)",
        },
        slate: {
          DEFAULT: "hsl(var(--slate) / <alpha-value>)",
          soft: "hsl(var(--slate-soft) / <alpha-value>)",
        },
        // R-2261: text on the amber / rose fills — white in light, dark paper in dark.
        "on-primary": "hsl(var(--on-primary) / <alpha-value>)",
        // shadcn/ui compatibility
        border: "hsl(var(--hairline) / <alpha-value>)",
        // R-2261: form-field borders (>= 3:1); the hairline stays for dividers and cards.
        input: "hsl(var(--input-border) / <alpha-value>)",
        ring: "hsl(var(--amber) / <alpha-value>)",
        primary: {
          DEFAULT: "hsl(var(--amber) / <alpha-value>)",
          foreground: "hsl(var(--on-primary) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--paper-2) / <alpha-value>)",
          foreground: "hsl(var(--ink) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--rose) / <alpha-value>)",
          foreground: "hsl(var(--on-primary) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--paper-2) / <alpha-value>)",
          foreground: "hsl(var(--ink-3) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--amber-soft) / <alpha-value>)",
          foreground: "hsl(var(--amber-ink) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--paper) / <alpha-value>)",
          foreground: "hsl(var(--ink) / <alpha-value>)",
        },
        card: {
          DEFAULT: "hsl(var(--paper) / <alpha-value>)",
          foreground: "hsl(var(--ink) / <alpha-value>)",
        },
      },
      borderRadius: {
        lg: "10px",
        md: "8px",
        sm: "6px",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "shimmer": {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
        "float-1": {
          "0%, 100%": { transform: "translateY(0) rotate(0deg)" },
          "50%": { transform: "translateY(-10px) rotate(-2deg)" },
        },
        "float-2": {
          "0%, 100%": { transform: "translateY(0) rotate(0deg)" },
          "50%": { transform: "translateY(-14px) rotate(3deg)" },
        },
        "float-3": {
          "0%, 100%": { transform: "translateY(0) rotate(0deg)" },
          "50%": { transform: "translateY(-8px) rotate(-2deg)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "shimmer": "shimmer 1.4s ease-in-out infinite",
        "float-1": "float-1 6s ease-in-out infinite",
        "float-2": "float-2 7s ease-in-out infinite",
        "float-3": "float-3 8s ease-in-out infinite",
      },
    },
  },
  plugins: [animate],
};

export default config;
