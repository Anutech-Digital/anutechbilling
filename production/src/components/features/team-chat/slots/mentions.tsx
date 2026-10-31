/**
 * Team chat slot — R-2303 (TC-10) @mentions — the popover over the box (claims Up/Down/Enter/Escape while open), fills draft.mentions.
 *
 * R-2299 left this as `null`; the card that builds it replaces this file with its
 * ChatExtension (see ../composer-slots.ts for the props each part receives). Nothing else in
 * the page needs editing: ../extensions.ts already includes this export.
 */
import type { ChatExtension } from "../composer-slots";

export const mentionsExtension: ChatExtension | null = null;
