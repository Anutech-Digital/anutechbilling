import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  caller: { userId: "user-a", tenantId: "tenant-a", canManage: true, admin: {} },
  connection: { pendingToken: "private-user-token", pendingAt: new Date().toISOString(), pageToken: null, pageId: null, pageName: null },
  pages: [{ id: "123", name: "Example Page", access_token: "private-page-token", tasks: ["CREATE_CONTENT"] }],
  select: vi.fn(),
}));

vi.mock("@/lib/integrations/facebook-page", () => ({
  facebookPageCaller: async () => mock.caller,
  readFacebookPage: async () => mock.connection,
  pendingIsFresh: () => true,
  listFacebookPages: async () => mock.pages,
  selectFacebookPage: mock.select,
  disconnectFacebookPage: vi.fn(),
  metaAppCreds: () => ({ appId: "app", appSecret: "secret" }),
}));

import { GET, POST } from "./route";

describe("Facebook Page selection", () => {
  beforeEach(() => { mock.select.mockReset(); mock.caller.canManage = true; });

  it("lists Page choices without sending either token to the browser", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Example Page");
    expect(text).not.toContain("private-user-token");
    expect(text).not.toContain("private-page-token");
  });

  it("refuses a Page not returned by Meta for this user", async () => {
    const response = await POST(new NextRequest("http://localhost/api/integrations/facebook-page", { method: "POST", body: JSON.stringify({ pageId: "999" }) }));
    expect(response.status).toBe(403);
    expect(mock.select).not.toHaveBeenCalled();
  });

  it("saves only a Page that Meta returned", async () => {
    const response = await POST(new NextRequest("http://localhost/api/integrations/facebook-page", { method: "POST", body: JSON.stringify({ pageId: "123" }) }));
    expect(response.status).toBe(200);
    expect(mock.select).toHaveBeenCalledWith(mock.caller.admin, "tenant-a", "user-a", mock.pages[0]);
  });
});
