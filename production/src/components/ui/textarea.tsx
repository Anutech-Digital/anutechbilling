/**
 * Textarea — multi-line text input.
 *
 * @example
 * <Textarea placeholder="Add a note…" rows={4} />
 * <Textarea error="Required" {...register("notes")} />
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string;
  helper?: string;
  /** Auto-grow with content (up to maxRows) */
  autoGrow?: boolean;
  maxRows?: number;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, helper, autoGrow, maxRows = 8, ...props }, ref) => {
    const hasError = !!error;
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

    // Combine refs
    React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement);

    // Auto-grow
    React.useEffect(() => {
      if (!autoGrow || !innerRef.current) return;
      const el = innerRef.current;
      const adjust = () => {
        el.style.height = "auto";
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight || "20");
        const maxHeight = lineHeight * maxRows;
        el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
      };
      el.addEventListener("input", adjust);
      adjust();
      return () => el.removeEventListener("input", adjust);
    }, [autoGrow, maxRows]);

    return (
      <div className="w-full">
        <textarea
          ref={innerRef}
          className={cn(
            "w-full rounded-md border bg-paper px-3 py-2 text-sm text-ink",
            "placeholder:text-ink-4 transition-colors resize-y",
            "focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-paper",
            hasError
              ? "border-rose focus:ring-rose"
              : "border-hairline focus:ring-amber focus:border-amber",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            autoGrow && "resize-none overflow-hidden",
            className
          )}
          aria-invalid={hasError || undefined}
          aria-describedby={error ? `${props.id}-error` : helper ? `${props.id}-helper` : undefined}
          {...props}
        />
        {error && (
          <p id={`${props.id}-error`} className="mt-1 text-xs text-rose">
            {error}
          </p>
        )}
        {helper && !error && (
          <p id={`${props.id}-helper`} className="mt-1 text-xs text-ink-3">
            {helper}
          </p>
        )}
      </div>
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
