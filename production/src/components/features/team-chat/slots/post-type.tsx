/**
 * Team chat slot — R-2304 (TC-11) post type — the Text / Problem / Suggestion switch (draft.kind), the status chip and Make a task / Report buttons on a post.
 *
 * R-2299 left this as `null`; the card that builds it replaces this file with its
 * ChatExtension (see ../composer-slots.ts for the props each part receives). Nothing else in
 * the page needs editing: ../extensions.ts already includes this export.
 */
import type { ChatExtension } from "../composer-slots";

export const postTypeExtension: ChatExtension | null = null;
