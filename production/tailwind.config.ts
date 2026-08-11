import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts,jsx,tsx}",
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
        emerald: {
          DEFAULT: "hsl(var(--emerald) / <alpha-value>)",
          soft: "hsl(var(--emerald-soft) / <alpha-value>)",
        },
        rose: {
          DEFAULT: "hsl(var(--rose) / <alpha-value>)",
          soft: "hsl(var(--rose-soft) / <alpha-value>)",
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
        // shadcn/ui compatibility
        border: "hsl(var(--hairline) / <alpha-value>)",
        input: "hsl(var(--hairline) / <alpha-value>)",
        ring: "hsl(var(--amber) / <alpha-value>)",
        primary: {
          DEFAULT: "hsl(var(--amber) / <alpha-value>)",
          foreground: "hsl(0 0% 100% / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--paper-2) / <alpha-value>)",
          foreground: "hsl(var(--ink) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--rose) / <alpha-value>)",
          foreground: "hsl(0 0% 100% / <alpha-value>)",
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
  plugins: [require("tailwindcss-animate")],
};

export default config;
