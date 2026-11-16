/**
 * Collapse — an open/close panel that animates both ways (src/site/motion.css), for the website's
 * FAQs and other click-to-open rows. The panel stays in the page while closed — so it can glide shut
 * instead of vanishing — but is `inert` and aria-hidden then: keyboard, screen readers and the
 * accessibility tree skip a closed answer exactly as when it was not rendered.
 *
 * The toggle stays the caller's own button with aria-expanded; pass the same `open`.
 */
import "@/site/motion.css";

export interface CollapseProps {
  open: boolean;
  children: React.ReactNode;
  id?: string;
  className?: string;
}

export function Collapse({ open, children, id, className }: CollapseProps) {
  return (
    <div id={id} className={className ? `s-collapse ${className}` : "s-collapse"} data-open={open ? "" : undefined}>
      <div className="s-collapse-in" inert={!open} aria-hidden={open ? undefined : true}>
        {children}
      </div>
    </div>
  );
}
