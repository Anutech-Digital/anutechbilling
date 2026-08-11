/**
 * Card — composable card surface used everywhere in the app.
 *
 * Use the composition pattern (Card / CardHeader / CardTitle / CardDescription / CardContent / CardFooter)
 * for flexibility. The shortcut props (title, sub, actions) are convenience wrappers.
 *
 * @example
 * <Card>
 *   <CardHeader>
 *     <CardTitle>Subscriptions</CardTitle>
 *     <CardDescription>All active + expired across vendors</CardDescription>
 *   </CardHeader>
 *   <CardContent>...</CardContent>
 * </Card>
 *
 * @example shortcut form
 * <Card title="Subscriptions" sub="Auto-synced" actions={<Button>Sync</Button>}>
 *   ...content
 * </Card>
 */
import * as React from "react";
import { cn } from "@/lib/utils";

interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Shortcut: renders a CardHeader internally */
  title?: React.ReactNode;
  /** Shortcut: renders inside CardHeader */
  sub?: React.ReactNode;
  /** Shortcut: actions row in the header */
  actions?: React.ReactNode;
  /** Less padding (tight layouts) */
  tight?: boolean;
  /** No padding on body (for full-bleed tables) */
  flush?: boolean;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, title, sub, actions, tight, flush, children, ...props }, ref) => {
    const useShortcut = title || sub || actions;
    return (
      <div
        ref={ref}
        className={cn(
          "bg-paper border border-hairline rounded-lg",
          "shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
          className
        )}
        {...props}
      >
        {useShortcut && (
          <CardHeader tight={tight} flush={flush}>
            <div className="flex-1 min-w-0">
              {title && <CardTitle>{title}</CardTitle>}
              {sub && <CardDescription>{sub}</CardDescription>}
            </div>
            {actions && <div className="flex items-center gap-1.5 flex-shrink-0">{actions}</div>}
          </CardHeader>
        )}
        {flush ? (
          // `flush` is for full-bleed tables — wrap in a horizontal scroll
          // container so a wide table scrolls *within* the card on narrow
          // (tablet) widths instead of overflowing and breaking the whole
          // page layout. `relative` is REQUIRED: it makes this the containing
          // block for absolutely-positioned descendants (e.g. `.sr-only`
          // labels in table headers) so they're clipped inside the scroller
          // instead of escaping to their static x-position past the viewport
          // and forcing a phantom page-level horizontal scrollbar. Radix
          // dialogs/menus render in portals, so this does not clip row popovers.
          <div className="overflow-x-auto relative">{children}</div>
        ) : (
          <div className={cn(tight ? "p-3" : "p-4")}>{children}</div>
        )}
      </div>
    );
  }
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { tight?: boolean; flush?: boolean }
>(({ className, tight, flush, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex items-start justify-between gap-3",
      flush ? "px-4 pt-3 pb-2" : tight ? "px-3 pt-3 pb-2 -mb-3" : "px-4 pt-4 pb-3 -mb-4",
      "border-b border-hairline mb-0",
      className
    )}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn("text-sm font-semibold text-ink leading-tight", className)}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-xs text-ink-3 mt-0.5", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-4", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex items-center justify-end gap-2 px-4 py-3 border-t border-hairline",
      className
    )}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
