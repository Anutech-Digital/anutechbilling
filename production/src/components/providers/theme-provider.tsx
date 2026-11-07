/**
 * ThemeProvider — wraps next-themes for dark/light/system mode.
 * No-flash dark mode supported via the `class` strategy.
 * R-2187: the default is "system" — until the user picks Light or Dark in the header, the app
 * follows the OS prefers-color-scheme (live, on change). A stored Light/Dark choice wins.
 */
"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ThemeProviderProps } from "next-themes";

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
