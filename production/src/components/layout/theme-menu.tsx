"use client";

/**
 * R-2187: the header theme control — System / Light / Dark. "System" (the default until the user
 * picks) follows the OS prefers-color-scheme, live; Light or Dark is stored and wins over the OS.
 * One set of choices in both places: the desktop icon menu (ThemeMenu) and the phone More menu
 * (ThemeMenuItems, rendered inside that menu's content).
 */
import * as React from "react";
import { useTheme } from "next-themes";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export const THEME_CHOICES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

/** The three choices, the current one ticked. Goes inside a DropdownMenuContent. */
export function ThemeMenuItems() {
  const { theme, setTheme } = useTheme();
  // Before mount next-themes has no theme on the server render — tick nothing until then.
  const mounted = useMounted();
  return (
    <>
      <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">Theme</DropdownMenuLabel>
      {THEME_CHOICES.map((c) => (
        <DropdownMenuCheckboxItem
          key={c.value}
          checked={mounted && (theme ?? "system") === c.value}
          onSelect={() => setTheme(c.value)}
        >
          {c.label}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  );
}

/** Desktop header button: sun/moon for what is showing now, opens System / Light / Dark. */
export function ThemeMenu({ className, ...rest }: { className?: string; "data-topbar"?: string }) {
  const { theme, resolvedTheme } = useTheme();
  const mounted = useMounted();
  const isDark = mounted && resolvedTheme === "dark";
  const current = THEME_CHOICES.find((c) => c.value === (theme ?? "system"))?.label ?? "System";
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <IconButton
              icon={isDark ? "moon" : "sun"}
              aria-label={mounted ? `Theme: ${current}` : "Theme"}
              className={className}
              {...rest}
            />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-40">
        <ThemeMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useMounted() {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}
