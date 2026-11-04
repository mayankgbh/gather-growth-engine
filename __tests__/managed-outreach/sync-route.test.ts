import { POST } from "@/app/api/managed-outreach/sync/route";

jest.mock("@/lib/managed-outreach/auth", () => ({ getManagedOwner: jest.fn() }));
jest.mock("@/lib/managed-outreach/client", () => ({ getManagedInstantlyClientForUserId: jest.fn() }));
jest.mock("@/lib/managed-outreach/sync", () => ({ syncManagedOutreach: jest.fn() }));
jest.mock("@/lib/prisma", () => ({ prisma: { workspace: { findUnique: jest.fn() } } }));
const { getManagedOwner } = require("@/lib/managed-outreach/auth");
const { getManagedInstantlyClientForUserId } = require("@/lib/managed-outreach/client");
const { syncManagedOutreach } = require("@/lib/managed-outreach/sync");
const { prisma } = require("@/lib/prisma");
const providerClient = { listEmails: jest.fn() };
const summary = { scannedJobs: 1, newEvents: [], pendingResponses: [], failures: [] };
function request() {
  return new Request("https://example.com/api/managed-outreach/sync?workspaceId=other-workspace&userId=other-user", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: "other-workspace", userId: "other-user", email: "other@example.com" }),
  });
}

describe("managed outreach sync endpoint", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    getManagedOwner.mockResolvedValue({ id: "owner-id", email: "owner@example.com" });
    prisma.workspace.findUnique.mockResolvedValue({ id: "owner-workspace", instantlyKey: "encrypted-example" });
    getManagedInstantlyClientForUserId.mockResolvedValue(providerClient);
    syncManagedOutreach.mockResolvedValue(summary);
  });

  it("rejects unauthorized requests before loading any workspace or provider data", async () => {
    getManagedOwner.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(getManagedInstantlyClientForUserId).not.toHaveBeenCalled();
    expect(syncManagedOutreach).not.toHaveBeenCalled();
  });

  it("uses only the authenticated owner's workspace and provider connection", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "owner-id" } }));
    expect(getManagedInstantlyClientForUserId.mock.calls[0][0]).toBe("owner-id");
    expect(syncManagedOutreach.mock.calls[0][0]).toBe("owner-workspace");
    expect(syncManagedOutreach.mock.calls[0][1]).toBe(providerClient);
    expect(await response.json()).toMatchObject(summary);
  });

  it("does not reconcile a missing owner workspace", async () => {
    prisma.workspace.findUnique.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(syncManagedOutreach).not.toHaveBeenCalled();
  });

  it("does not reconcile without the saved owner provider connection", async () => {
    getManagedInstantlyClientForUserId.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(syncManagedOutreach).not.toHaveBeenCalled();
  });

  it("does not return raw provider or database failures", async () => {
    syncManagedOutreach.mockRejectedValue(new Error("synthetic-provider-token must not escape"));
    const response = await POST(request());
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-provider-token");
  });
});
