/**
 * Checkbox — accessible (Radix-based).
 *
 * @example
 * <Checkbox checked={agreed} onCheckedChange={setAgreed} id="terms" />
 * <Label htmlFor="terms">I agree to the terms</Label>
 */
"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * R-269: a 16px box is a miss for a thumb. On touch screens (pointer: coarse) an
 * invisible 40x40 ::after, centred on the control, takes the tap; the visible box and
 * the mouse layout do not change. `relative` places the pseudo element against the
 * control. Shared with Switch.
 */
export const touchTargetClass =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:left-1/2 " +
  "[@media(pointer:coarse)]:after:top-1/2 [@media(pointer:coarse)]:after:h-10 " +
  "[@media(pointer:coarse)]:after:w-10 [@media(pointer:coarse)]:after:-translate-x-1/2 " +
  "[@media(pointer:coarse)]:after:-translate-y-1/2";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded border border-hairline-strong",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:bg-amber data-[state=checked]:border-amber data-[state=checked]:text-white",
      "transition-colors",
      touchTargetClass,
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn("flex items-center justify-center text-current")}>
      <Check className="h-3.5 w-3.5" strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
