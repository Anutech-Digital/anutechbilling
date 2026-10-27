/**
 * R-2020 (R-2019 decisions 4 and 8): placeholders stay hidden until the real content exists —
 * never invented. Turn a flag on only when Pardeep has sent the thing it shows.
 *  - SHOW_SOCIAL_PROOF: Google rating + count, businesses served, two testimonials (with written
 *    permission), customer logos, the partner-directory link.
 *  - FOUNDER_PHOTO_URL: the founder card's photo (null → no photo, no "Add photo" box).
 */
export const SHOW_SOCIAL_PROOF: boolean = false;
export const FOUNDER_PHOTO_URL: string | null = null;
