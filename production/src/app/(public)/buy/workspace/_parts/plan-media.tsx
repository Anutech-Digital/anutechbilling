"use client";
/**
 * R-1988 (Pardeep, 26 Oct 2026): the media slot in a priced plan card — the space the aligned
 * buttons left between "Billed yearly" and the total.
 *   - With a YouTube link (PLAN_MEDIA, plans.ts — the links Pardeep gives; never a guessed id):
 *     a LITE embed. On load only the thumbnail image (i.ytimg.com) — no YouTube script, frame or
 *     cookie. A click swaps in the youtube-nocookie.com player, autoplaying.
 *   - Without one: three short feature highlights.
 */
import * as React from "react";

export interface PlanMediaLink { youtubeId: string; title: string }

/** A YouTube video id (11 characters of A–Z a–z 0–9 - _), or null — anything else is never embedded. */
export function youtubeId(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
}

export function PlanMedia({ media, highlights }: { media: PlanMediaLink | undefined; highlights: readonly string[] }) {
  const [playing, setPlaying] = React.useState(false);
  const id = youtubeId(media?.youtubeId);
  if (!id || !media) {
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
    <div className="mt-3 relative w-full aspect-video rounded-lg overflow-hidden bg-ink" data-testid="plan-media">
      {playing ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`}
          title={media.title}
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          className="absolute inset-0 w-full h-full border-0"
        />
      ) : (
        <button
          type="button"
          aria-label={`Play video: ${media.title}`}
          onClick={() => setPlaying(true)}
          className="group absolute inset-0 w-full h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- YouTube's own thumbnail, lazy */}
          <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" decoding="async" className="absolute inset-0 w-full h-full object-cover" />
          <span aria-hidden className="absolute inset-0 grid place-items-center">
            <span className="w-12 h-12 rounded-full bg-black/70 group-hover:bg-amber grid place-items-center text-white text-lg pl-0.5">▶</span>
          </span>
        </button>
      )}
    </div>
  );
}
