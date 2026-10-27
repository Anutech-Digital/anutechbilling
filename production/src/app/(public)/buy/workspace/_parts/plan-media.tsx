/**
 * R-1988 (Pardeep, 26 Oct 2026): the media slot in a priced plan card — right under the
 * description (R-2030), above the rate box.
 * R-2031 (Pardeep, 27 Oct 2026, "this image goes in place of 1"): the slot holds Pardeep's
 * "Google Workspace + apps" image (PLAN_MEDIA, plans.ts → public/buy/workspace-apps.webp) — the
 * YouTube video is gone. Same 16:9 slot as the video had, so the cards and buttons stay aligned;
 * the whole image shows (object-contain), lazy-loaded, with fixed width/height (no layout shift).
 *   - Without media: three short feature highlights.
 */
import * as React from "react";

export interface PlanMediaImage { src: string; width: number; height: number; alt: string }

export function PlanMedia({ media, highlights }: { media: PlanMediaImage | undefined; highlights: readonly string[] }) {
  if (!media) {
    return (
      <ul className="list-none p-0 m-0 mt-3 flex flex-col gap-1.5" data-testid="plan-media">
        {highlights.slice(0, 3).map((h) => (
          <li key={h} className="flex gap-2 items-start text-[13px] text-ink-2 leading-snug">
            <span aria-hidden className="text-amber-ink font-bold shrink-0">★</span><span>{h}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="mt-3 relative w-full aspect-video rounded-lg overflow-hidden" data-testid="plan-media">
      {/* eslint-disable-next-line @next/next/no-img-element -- a small static webp in public/, lazy, fixed size */}
      <img
        src={media.src}
        width={media.width}
        height={media.height}
        alt={media.alt}
        loading="lazy"
        decoding="async"
        className="absolute inset-0 w-full h-full object-contain"
      />
    </div>
  );
}
