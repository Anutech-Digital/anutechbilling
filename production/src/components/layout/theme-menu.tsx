"use client";

/**
 * R-2187: the header theme control — System / Light / Dark. "System" (the default until the user
 * picks) follows the OS prefers-color-scheme, live; Light or Dark is stored and wins over the OS.
 * One set of choices in both places: the desktop icon menu (ThemeMenu) and the phone More menu
 * (ThemeMenuItems, rendered inside that menu's content). The three are one choice, so they are a
 * radio group (menuitemradio), not checkboxes.
 */
import * as React from "react";
import { Check } from "lucide-react";
import { useTheme } from "next-themes";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { IconButton } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export const THEME_CHOICES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;
type ThemeChoice = (typeof THEME_CHOICES)[number];

/** The stored choice as one of the three — anything else (none yet, an old value) is System. */
function choiceOf(theme: string | undefined): ThemeChoice {
  return THEME_CHOICES.find((c) => c.value === theme) ?? THEME_CHOICES[0];
}

/** The three choices, the current one ticked. Goes inside a DropdownMenuContent. */
export function ThemeMenuItems() {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={choiceOf(theme).value} onValueChange={setTheme}>
        {THEME_CHOICES.map((c) => (
          <DropdownMenuPrimitive.RadioItem
            key={c.value}
            value={c.value}
            className="relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-paper-2"
          >
            <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
              <DropdownMenuPrimitive.ItemIndicator>
                <Check className="h-4 w-4 text-amber" />
              </DropdownMenuPrimitive.ItemIndicator>
            </span>
            {c.label}
          </DropdownMenuPrimitive.RadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/** Desktop header button: moon/sun for what is showing now, opens System / Light / Dark. */
export function ThemeMenu({ className, ...rest }: { className?: string; "data-topbar"?: string }) {
  const { theme, resolvedTheme } = useTheme();
  // next-themes knows nothing on the server render — the icon and label wait for mount.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === "dark";
  return (
    <DropdownMenu modal={false}>
      {/* No tooltip: focus returns here when a choice is picked and would pop it open again. */}
      <DropdownMenuTrigger asChild>
        <IconButton
          icon={isDark ? "moon" : "sun"}
          aria-label={mounted ? `Theme: ${choiceOf(theme).label}` : "Theme"}
          className={className}
          {...rest}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <ThemeMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
