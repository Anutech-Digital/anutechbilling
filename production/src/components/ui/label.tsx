/**
 * Label — accessible form label (Radix-based).
 *
 * @example
 * <Label htmlFor="email">Email address</Label>
 * <Input id="email" {...register("email")} />
 *
 * <Label required>Company name</Label>  // adds red asterisk
 */
"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & {
    required?: boolean;
  }
>(({ className, children, required, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      "text-xs font-medium leading-none text-ink-2 select-none",
      "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className
    )}
    {...props}
  >
    {children}
    {required && (
      <span className="text-rose ml-0.5" aria-label="required">
        *
      </span>
    )}
  </LabelPrimitive.Root>
));
Label.displayName = LabelPrimitive.Root.displayName;

/**
 * Form field wrapper — Label + Input + error/helper.
 * Combines our Label + the Input's error/helper for a clean API.
 */
function FormField({
  label,
  required,
  children,
  htmlFor,
  className,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  htmlFor?: string;
  /** Applied to the field wrapper — e.g. grid column spans. */
  className?: string;
}) {
  return (
    <div className={className ? `space-y-1.5 ${className}` : "space-y-1.5"}>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {children}
    </div>
  );
}

export { Label, FormField };
