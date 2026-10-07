/**
 * Button — production-grade button with variants, sizes, icon support,
 * loading state, and asChild composition (for wrapping Next.js Link, etc.).
 *
 * Replaces the prototype's <Btn /> component.
 *
 * @example
 * <Button>Default</Button>
 * <Button variant="primary" icon="send">Send quote</Button>
 * <Button variant="danger" loading>Deleting…</Button>
 * <Button asChild><Link href="/leads">Leads</Link></Button>
 */
"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

const buttonVariants = cva(
  // Base
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium " +
  "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-paper " +
  "disabled:pointer-events-none disabled:opacity-50 select-none " +
  // R-269: under a finger (pointer: coarse) no button is shorter than 40px. A mouse
  // sees the exact sizes below; only touch screens get the taller target.
  "[@media(pointer:coarse)]:min-h-10",
  {
    variants: {
      variant: {
        // Quiet / default — white with hairline border (most common)
        default:
          "bg-paper text-ink border border-hairline hover:bg-paper-2 active:bg-paper-2/80",
        // Primary — brand amber
        primary:
          "bg-amber text-white hover:bg-amber/90 active:bg-amber/80 shadow-sm",
        // Destructive — for delete, cancel-subscription, etc.
        danger:
          "bg-rose text-white hover:bg-rose/90 active:bg-rose/80 shadow-sm",
        // Ghost — minimal, for icon-heavy toolbars
        ghost:
          "bg-transparent text-ink hover:bg-paper-2 active:bg-paper-2/80",
        // Outline — for secondary CTAs
        outline:
          "bg-transparent text-ink border border-ink hover:bg-paper-2",
        // Link — for inline text actions
        link:
          "bg-transparent text-amber underline-offset-4 hover:underline p-0 h-auto " +
          // Inline text link sits in a sentence: it must not grow to 40px on touch.
          "[@media(pointer:coarse)]:min-h-0",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4 text-sm",
        lg: "h-11 px-6 text-base",
        icon: "h-9 w-9 p-0 [@media(pointer:coarse)]:min-w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render as a different element (e.g., wrap a Next.js Link) */
  asChild?: boolean;
  /** Show a spinner and disable the button */
  loading?: boolean;
  /** Icon name (left side) */
  icon?: string;
  /** Icon name (right side) */
  iconRight?: string;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      disabled,
      icon,
      iconRight,
      children,
      ...props
    },
    ref
  ) => {
    const iconSize = size === "lg" ? 18 : size === "sm" ? 13 : 15;

    // Compose the inner content (loading spinner / icon / children / iconRight)
    const inner = (
      <>
        {loading ? (
          <Loader2 className="animate-spin" size={iconSize} aria-hidden="true" />
        ) : (
          icon && <Icon name={icon} size={iconSize} />
        )}
        {children}
        {iconRight && !loading && <Icon name={iconRight} size={iconSize} />}
      </>
    );

    // When asChild, we need to wrap the user's child element (e.g., <Link>)
    // and merge our icons into ITS children — Slot requires exactly one child.
    if (asChild) {
      const child = React.Children.only(children) as React.ReactElement<{ children?: React.ReactNode }>;
      const slotChild = React.cloneElement(child, undefined, (
        <>
          {loading ? <Loader2 className="animate-spin" size={iconSize} aria-hidden="true" /> : icon && <Icon name={icon} size={iconSize} />}
          {child.props.children}
          {iconRight && !loading && <Icon name={iconRight} size={iconSize} />}
        </>
      ));
      return (
        <Slot
          className={cn(buttonVariants({ variant, size }), className)}
          ref={ref}
          {...props}
        >
          {slotChild}
        </Slot>
      );
    }

    return (
      <button
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        ref={ref}
        {...props}
      >
        {inner}
      </button>
    );
  }
);
Button.displayName = "Button";

/**
 * IconButton — square button optimized for icon-only actions.
 * Includes accessible tooltip via `title` attribute.
 */
export interface IconButtonProps
  extends Omit<ButtonProps, "icon" | "iconRight" | "size" | "children"> {
  icon: string;
  /** Required for accessibility */
  "aria-label": string;
  size?: "sm" | "md" | "lg";
}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, size = "md", className, ...props }, ref) => {
    const iconSize = size === "lg" ? 20 : size === "sm" ? 14 : 16;
    const sizeClass = size === "lg" ? "h-11 w-11" : size === "sm" ? "h-7 w-7" : "h-9 w-9";

    return (
      <Button
        ref={ref}
        variant="ghost"
        // R-269: square on touch too — the base gives min-h-10, this gives the width.
        className={cn("p-0 [@media(pointer:coarse)]:min-w-10", sizeClass, className)}
        {...props}
      >
        <Icon name={icon} size={iconSize} />
      </Button>
    );
  }
);
IconButton.displayName = "IconButton";

export { Button, IconButton, buttonVariants };
