/**
 * Input — text input with error state, prefix/suffix support.
 *
 * React Hook Form compatible — works with {...register("field")}.
 *
 * @example
 * <Input placeholder="Search…" />
 * <Input prefix={<Icon name="search" />} placeholder="Search…" />
 * <Input suffix="@yourcompany.com" placeholder="domain" />
 * <Input error="Invalid email" {...register("email")} />
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  /** Prefix node (icon, text) — inside the input border */
  prefix?: React.ReactNode;
  /** Suffix node */
  suffix?: React.ReactNode;
  /** Error message — shows below input + red border */
  error?: string;
  /** Helper text — shown below if no error */
  helper?: string;
  /** Optional wrapper className (applies to outer div, not the input) */
  wrapperClassName?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", prefix, suffix, error, helper, wrapperClassName, onFocus, ...props }, ref) => {
    const hasError = !!error;
    // Number fields default to "0"; selecting the value on focus means the first
    // keystroke replaces it (no manual delete). Deferred so a mouse-click's caret
    // placement doesn't wipe the selection. Text/search fields keep normal focus.
    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      if (type === "number") {
        const el = e.currentTarget;
        requestAnimationFrame(() => el.select());
      }
      onFocus?.(e);
    };
    return (
      <div className={cn("w-full", wrapperClassName)}>
        <div
          className={cn(
            "flex items-center w-full rounded-md border bg-paper transition-colors",
            "focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-paper",
            hasError
              ? "border-rose focus-within:ring-rose"
              : "border-hairline focus-within:ring-amber focus-within:border-amber",
            props.disabled && "opacity-50 cursor-not-allowed bg-paper-2"
          )}
        >
          {prefix && (
            <span className="pl-3 text-ink-3 flex items-center pointer-events-none flex-shrink-0">
              {prefix}
            </span>
          )}
          <input
            ref={ref}
            type={type}
            className={cn(
              "flex-1 bg-transparent border-0 outline-none text-sm text-ink placeholder:text-ink-4",
              "px-3 py-2 min-w-0",
              prefix && "pl-2",
              suffix && "pr-2",
              "disabled:cursor-not-allowed",
              className
            )}
            aria-invalid={hasError || undefined}
            aria-describedby={error ? `${props.id}-error` : helper ? `${props.id}-helper` : undefined}
            onFocus={handleFocus}
            {...props}
          />
          {suffix && (
            <span className="pr-3 text-ink-3 text-sm flex items-center flex-shrink-0">
              {suffix}
            </span>
          )}
        </div>
        {error && (
          <p id={`${props.id}-error`} className="mt-1 text-xs text-rose flex items-center gap-1">
            <span>{error}</span>
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
Input.displayName = "Input";

export { Input };
