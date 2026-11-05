import { NextResponse, type NextRequest } from "next/server";
import {
  disconnectFacebookPage, facebookPageCaller, listFacebookPages, metaAppCreds, pendingIsFresh,
  readFacebookPage, selectFacebookPage,
} from "@/lib/integrations/facebook-page";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const caller = await facebookPageCaller();
  if (!caller) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  try {
    const connection = await readFacebookPage(caller.admin, caller.tenantId);
    const choosing = caller.canManage && Boolean(connection.pendingToken && pendingIsFresh(connection.pendingAt));
    const pages = choosing ? await listFacebookPages(connection.pendingToken!) : [];
    return NextResponse.json({
      configured: Boolean(metaAppCreds()), canManage: caller.canManage,
      connected: Boolean(connection.pageId && connection.pageToken),
      pageId: connection.pageId, pageName: connection.pageName,
      choosing, pages: pages.map(({ id, name, tasks }) => ({ id, name, tasks })),
    });
  } catch (error) {
    console.error("[facebook-page] status failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not load Facebook Pages. Check the Page permissions and try again." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const caller = await facebookPageCaller();
  if (!caller) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!caller.canManage) return NextResponse.json({ error: "Only an owner or manager can connect a Page." }, { status: 403 });
  const body = await request.json().catch(() => null) as { pageId?: unknown } | null;
  const pageId = typeof body?.pageId === "string" ? body.pageId.trim() : "";
  if (!/^\d{1,30}$/.test(pageId)) return NextResponse.json({ error: "Choose a valid Page." }, { status: 400 });
  try {
    const connection = await readFacebookPage(caller.admin, caller.tenantId);
    if (!connection.pendingToken || !pendingIsFresh(connection.pendingAt)) return NextResponse.json({ error: "Page selection expired. Connect Facebook again." }, { status: 409 });
    const page = (await listFacebookPages(connection.pendingToken)).find((item) => item.id === pageId);
    if (!page) return NextResponse.json({ error: "This Page is not available to your Facebook account." }, { status: 403 });
    await selectFacebookPage(caller.admin, caller.tenantId, caller.userId, page);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[facebook-page] select failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "Could not connect the Facebook Page. Try again." }, { status: 502 });
  }
}

export async function DELETE() {
  const caller = await facebookPageCaller();
  if (!caller) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!caller.canManage) return NextResponse.json({ error: "Only an owner or manager can disconnect a Page." }, { status: 403 });
  try {
    await disconnectFacebookPage(caller.admin, caller.tenantId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not disconnect the Facebook Page." }, { status: 500 });
  }
}
