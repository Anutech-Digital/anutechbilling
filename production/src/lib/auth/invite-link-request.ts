/**
 * R-2517 — reading the emailed invite link's token from a request body ({ token }). Shared by
 * POST /api/team/invites/lookup and /accept. Isomorphic (no node:crypto) so the shape check can
 * also run in the browser page.
 */
export const INVITE_LINK_BROKEN_MESSAGE =
  "This invite link is incomplete. Open the link from the invite email again (copy the whole link), or ask the company to invite you again.";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

export function inviteTokenShapeOk(v: unknown): v is string {
  return typeof v === "string" && TOKEN_SHAPE.test(v);
}

export async function readInviteToken(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const t = typeof body?.token === "string" ? body.token.trim() : null;
  return inviteTokenShapeOk(t) ? t : null;
}
